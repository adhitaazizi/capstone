"""Per-camera ML inference + center-point optical flow tracking.

ARCHITECTURE
============
INFERENCE THREAD (bottlenecked at ~620 ms/call by local Roboflow CPU server):
  Grabs last_model_frame → serialized via class semaphore → detections →
  CentroidTracker → snaps FlowTracker box centers to ML ground truth.

FLOW THREAD (10 fps, 100 ms intervals):
  Converts last_model_frame to grayscale → LK optical flow on box CENTER
  POINTS → updates _latest every 100 ms.

WHY CENTER-POINT (not goodFeaturesToTrack):
  goodFeaturesToTrack spread across the full box hits spindle-arm background
  edges (high-contrast black/white → strong corners) which move at a different
  angle than the car when the spindle rotates.  One point at the box centroid
  means the 21×21 LK patch is centered on the car body.  ML snap every ~1.24 s
  (2-camera serialized semaphore) resets accumulated drift to ground truth.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger("tracking-stream")

MAX_MISSED    = 2
MAX_DIST      = 200.0
INFERENCE_FPS = 1
FLOW_FPS      = 10

LK_PARAMS: dict[str, Any] = dict(
    winSize=(25, 25),
    maxLevel=4,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 15, 0.03),
)


# ── Centroid tracker ──────────────────────────────────────────────────────────

class _Track:
    __slots__ = ("id", "x", "y", "width", "height", "confidence", "cls", "age", "missed")

    def __init__(self, tid: int, det: dict[str, Any]) -> None:
        self.id         = tid
        self.x: float  = float(det["x"])
        self.y: float  = float(det["y"])
        self.width      = float(det.get("width",  40))
        self.height     = float(det.get("height", 40))
        self.confidence = float(det.get("confidence", 0))
        self.cls        = str(det.get("class", "?"))
        self.age        = 1
        self.missed     = 0

    def update(self, det: dict[str, Any]) -> None:
        self.x          = 0.7 * float(det["x"])     + 0.3 * self.x
        self.y          = 0.7 * float(det["y"])     + 0.3 * self.y
        self.width      = float(det.get("width",  self.width))
        self.height     = float(det.get("height", self.height))
        self.confidence = float(det.get("confidence", self.confidence))
        self.cls        = str(det.get("class", self.cls))
        self.age       += 1
        self.missed     = 0


class CentroidTracker:
    def __init__(self) -> None:
        self._tracks: dict[int, _Track] = {}
        self._next_id = 0

    def update(self, detections: list[dict[str, Any]]) -> None:
        for t in self._tracks.values():
            t.missed += 1
        matched: set[int] = set()
        for det in detections:
            best_id: int | None = None
            best_dist = MAX_DIST
            for tid, t in self._tracks.items():
                if tid in matched:
                    continue
                d = math.hypot(float(det["x"]) - t.x, float(det["y"]) - t.y)
                if d < best_dist:
                    best_dist = d
                    best_id = tid
            if best_id is not None:
                matched.add(best_id)
                self._tracks[best_id].update(det)
            else:
                self._tracks[self._next_id] = _Track(self._next_id, det)
                self._next_id += 1
        self._tracks = {tid: t for tid, t in self._tracks.items()
                        if t.missed <= MAX_MISSED}

    def visible(self) -> list[_Track]:
        return [t for t in self._tracks.values() if t.missed == 0]


# ── Center-point flow tracker ─────────────────────────────────────────────────

class FlowTracker:
    """Propagates box centers between ML ticks using LK optical flow.

    One LK point per detection (the centroid).  The 25×25 window at
    pyramid level 4 can handle ~200 px displacement per frame pair —
    large enough to survive the 1.24 s ML gap even on a fast spindle.

    Thread model:
        snap()       called from inference thread   (holds _lock briefly)
        flow_step()  called from flow thread
            - reads points under _lock (fast)
            - runs LK WITHOUT lock (CPU-intensive, ~5-15 ms)
            - writes updated points under _lock (fast)
        get_detections()  called from flow thread / get_latest_detections
    """

    def __init__(self) -> None:
        self._lock       = threading.Lock()
        self._prev_gray: np.ndarray | None = None
        # id → [cx, cy, w, h, confidence, class_name]
        self._boxes: dict[int, list[Any]] = {}

    # Called from inference thread
    def snap(self, tracks: list[_Track]) -> None:
        """Reset box centers to ML-detected positions (ground-truth anchor)."""
        with self._lock:
            new_ids = {t.id for t in tracks}
            self._boxes = {tid: box for tid, box in self._boxes.items()
                           if tid in new_ids}
            for t in tracks:
                if t.id in self._boxes:
                    # Keep existing w/h/meta; only update center + confidence
                    self._boxes[t.id][0] = t.x
                    self._boxes[t.id][1] = t.y
                    self._boxes[t.id][4] = t.confidence
                    self._boxes[t.id][5] = t.cls
                else:
                    self._boxes[t.id] = [t.x, t.y, t.width, t.height,
                                         t.confidence, t.cls]

    # Called from flow thread only — prev_gray never touched by inference thread
    def flow_step(self, curr_gray: np.ndarray) -> None:
        """One LK step: track center points from prev_gray to curr_gray."""
        if self._prev_gray is None:
            self._prev_gray = curr_gray
            return

        # Fast: snapshot current center points under lock
        with self._lock:
            if not self._boxes:
                self._prev_gray = curr_gray
                return
            ids  = list(self._boxes.keys())
            pts  = np.array([[[self._boxes[tid][0], self._boxes[tid][1]]]
                             for tid in ids], dtype=np.float32)
        prev_g = self._prev_gray

        # CPU-intensive LK — no lock held
        new_pts, status, _ = cv2.calcOpticalFlowPyrLK(
            prev_g, curr_gray, pts, None, **LK_PARAMS
        )
        self._prev_gray = curr_gray

        # Fast: write results under lock
        with self._lock:
            for tid, st, new_pt in zip(ids, status, new_pts):
                if st[0] == 1 and tid in self._boxes:
                    self._boxes[tid][0] = max(0.0, min(639.0, float(new_pt[0][0])))
                    self._boxes[tid][1] = max(0.0, min(639.0, float(new_pt[0][1])))

    def get_detections(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {
                    "id":         tid,
                    "x":          round(b[0], 1),
                    "y":          round(b[1], 1),
                    "width":      round(b[2], 1),
                    "height":     round(b[3], 1),
                    "confidence": round(b[4], 3),
                    "class":      b[5],
                }
                for tid, b in self._boxes.items()
            ]

    def has_tracks(self) -> bool:
        with self._lock:
            return bool(self._boxes)


# ── TrackingStream ────────────────────────────────────────────────────────────

class TrackingStream:
    """Inference + flow for one camera.

    Bottleneck note: the local Roboflow server handles ~1.6 calls/s total.
    With 2 cameras sharing the semaphore, each camera gets ~0.8 fps ML updates
    (~1.24 s between ML snaps).  The 10 fps flow thread fills that gap so boxes
    follow cars visually rather than freezing for 1.24 s.
    """

    _inference_sem: threading.Semaphore = threading.Semaphore(1)

    def __init__(
        self,
        camera_id: str,
        frame_capture: Any,
        inference: Any,
        target_fps: int = 1,
    ) -> None:
        self.camera_id  = camera_id
        self._capture   = frame_capture
        self._inference = inference
        self._tracker   = CentroidTracker()
        self._flow      = FlowTracker()
        self._latest: list[dict[str, Any]] = []
        self._lock      = threading.Lock()
        self._stop      = threading.Event()
        self._infer_thread: threading.Thread | None = None
        self._flow_thread:  threading.Thread | None = None

    def start(self) -> None:
        self._infer_thread = threading.Thread(
            target=self._infer_loop, daemon=True, name=f"infer-{self.camera_id}"
        )
        self._flow_thread = threading.Thread(
            target=self._flow_loop, daemon=True, name=f"flow-{self.camera_id}"
        )
        self._infer_thread.start()
        self._flow_thread.start()
        logger.info("TrackingStream started for %s", self.camera_id)

    def stop(self) -> None:
        self._stop.set()

    def get_latest_detections(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._latest)

    # ── inference loop (~0.8 fps limited by semaphore) ────────────────────────

    def _infer_loop(self) -> None:
        interval = 1.0 / max(INFERENCE_FPS, 1)
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._infer_tick()
            except Exception as exc:
                logger.warning("Inference tick error for %s: %s", self.camera_id, exc)
            wait = interval - (time.monotonic() - t0)
            if wait > 0:
                self._stop.wait(wait)

    def _infer_tick(self) -> None:
        frame = self._capture.last_model_frame
        if frame is None:
            return
        with TrackingStream._inference_sem:
            result = self._inference.detect(self.camera_id, frame)
        raw = list(result.get("detections", []))
        self._tracker.update(raw)
        visible = self._tracker.visible()
        self._flow.snap(visible)  # anchor flow positions to ML ground truth

    # ── flow loop (10 fps) ────────────────────────────────────────────────────

    def _flow_loop(self) -> None:
        interval = 1.0 / FLOW_FPS
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._flow_tick()
            except Exception as exc:
                logger.warning("Flow tick error for %s: %s", self.camera_id, exc)
            wait = interval - (time.monotonic() - t0)
            if wait > 0:
                self._stop.wait(wait)

    def _flow_tick(self) -> None:
        frame = self._capture.last_model_frame
        if frame is None:
            return
        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self._flow.flow_step(curr_gray)
        if self._flow.has_tracks():
            dets = self._flow.get_detections()
            with self._lock:
                self._latest = dets
