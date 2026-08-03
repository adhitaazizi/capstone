"""Main orchestrator for the simulated edge-compute pipeline."""

from __future__ import annotations

import json
import logging
import signal
import threading
import time
import urllib.error
import urllib.request
from importlib import import_module
from typing import Any, Dict, List, Optional, Protocol

EdgeConfigLoader = import_module("config")
CrossCameraDeduplicator = import_module("deduplication").CrossCameraDeduplicator
_frame_capture_mod = import_module("frame_capture")
FrameCapture = _frame_capture_mod.FrameCapture
RoboflowInference = import_module("inference").RoboflowInference
MJPEGServer = import_module("mjpeg_server").MJPEGServer
EdgePublisher = import_module("publisher").EdgePublisher
FIFOReconciler = import_module("reconciler").FIFOReconciler
RowTracker = import_module("row_tracker").RowTracker
TrackingStream = import_module("tracking_stream").TrackingStream
load_config = EdgeConfigLoader.load_config


class EdgeConfig(Protocol):
    confidence_threshold: float
    roboflow_api_url: str
    roboflow_api_key: str
    roboflow_workspace: str
    roboflow_workflow: str
    roboflow_image_input: str
    roboflow_stream_outputs: list[str]
    roboflow_data_outputs: list[str]
    roboflow_processing_timeout: int
    roboflow_requested_plan: str | None
    roboflow_requested_region: str | None
    camera_sources: dict[str, str]
    rabbitmq_url: str
    mjpeg_port: int
    active_session_id: str
    spindle_gap_seconds: float
    entry_cameras: list[str]
    conveyor_travel_seconds: float
    exit_cameras: list[str]
    health_interval_seconds: int
    target_fps: int
    num_spindle_rows: int
    row_y_tolerance: int
    rotation_timeout_seconds: float

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("edge-main")


class EdgeOrchestrator:
    """Capture, infer, deduplicate, reconcile, publish, repeat.

    Entry and exit detection run on separate threads so that multiple
    spindles can be in-flight on the conveyor simultaneously.  The FIFO
    reconciler matches the oldest entry to each exit in order.

    Timeline (spindle_gap=5s, travel=10s):
        t= 0  entry-loop: spindle A enters  → FIFO depth 1
        t= 5  entry-loop: spindle B enters  → FIFO depth 2
        t=10  exit-loop : spindle A exits   → FIFO depth 1  (matched/mismatched)
        t=15  exit-loop : spindle B exits   → FIFO depth 0
    """

    def __init__(self, config: EdgeConfig) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.captures = {
            camera_id: FrameCapture(camera_id, source, target_fps=config.target_fps)
            for camera_id, source in config.camera_sources.items()
        }
        self.inference = RoboflowInference(
            api_key=config.roboflow_api_key,
            api_url=config.roboflow_api_url,
            workspace=config.roboflow_workspace,
            workflow=config.roboflow_workflow,
            image_input=config.roboflow_image_input,
            camera_sources=config.camera_sources,
            confidence_threshold=config.confidence_threshold,
            stream_output=config.roboflow_stream_outputs,
            data_output=config.roboflow_data_outputs,
            processing_timeout=config.roboflow_processing_timeout,
            requested_plan=config.roboflow_requested_plan,
            requested_region=config.roboflow_requested_region,
            model_project=config.roboflow_model_project,
            model_version=config.roboflow_model_version,
            mock_count=config.mock_spindle_count,
        )
        self.tracking_streams = {
            camera_id: TrackingStream(camera_id, capture, self.inference, target_fps=config.target_fps)
            for camera_id, capture in self.captures.items()
        }
        self.deduplicator = CrossCameraDeduplicator.identity_for(self.captures.keys())
        self.reconciler = FIFOReconciler()
        self.publisher = EdgePublisher(config.rabbitmq_url)
        self.mjpeg_server = MJPEGServer(port=config.mjpeg_port)
        self.health_thread: Optional[threading.Thread] = None
        self._missing_checkpoint_cameras: set[tuple[str, str]] = set()

    def start(self) -> None:
        for capture in self.captures.values():
            capture.open()

        for camera_id, capture in self.captures.items():
            t = threading.Thread(
                target=self._frame_reader_loop,
                args=(capture,),
                daemon=True,
                name=f"frame-reader-{camera_id}",
            )
            t.start()

        self.inference.start()
        for ts in self.tracking_streams.values():
            ts.start()
        self.publisher.connect()
        self.mjpeg_server.start(self.captures, self.tracking_streams)
        self.health_thread = threading.Thread(target=self._health_loop, daemon=True)
        self.health_thread.start()
        logger.info(
            "Edge orchestrator started for session %s (backend=roboflow)",
            self.config.active_session_id,
        )

    def run_forever(self) -> None:
        self.start()
        exit_thread = threading.Thread(
            target=self._exit_loop,
            daemon=True,
            name="exit-loop",
        )
        exit_thread.start()
        try:
            self._entry_loop()
        finally:
            self.stop()

    # ------------------------------------------------------------------
    # Entry loop — runs on the main thread
    # ------------------------------------------------------------------

    def _entry_loop(self) -> None:
        """Detect spindle entries continuously at spindle_gap_seconds cadence."""
        while not self.stop_event.is_set():
            session_id = self._poll_active_session()
            if session_id is None:
                logger.info("No active production session — waiting for one to be started")
                self._sleep(5.0)
                continue
            self._run_entry(session_id)
            self._sleep(self.config.spindle_gap_seconds)

    def _run_entry(self, session_id: str) -> None:
        count, checkpoint = self._observe_spindle_entry()
        if count == 0:
            logger.info("No spindle detected at entry — skipping")
            return
        spindle_pass_id = self.reconciler.push_entry(session_id, count)
        self.publisher.publish_entry(
            {
                **checkpoint,
                "spindle_pass_id": spindle_pass_id,
                "session_id": session_id,
            }
        )

    def _observe_spindle_entry(self) -> tuple[int, Dict[str, Any]]:
        """Sample the primary entry camera until a full spindle rotation is seen.

        Uses Y-position clustering to identify unique rows.  Stops as soon as
        a previously-seen row reappears (rotation complete) or all expected
        rows have been recorded.  Falls back to whatever was seen when the
        observation timeout expires.

        Returns (unique_car_count, checkpoint_metadata).
        """
        primary = self.config.entry_cameras[0] if self.config.entry_cameras else None
        tracker = RowTracker(
            y_tolerance=self.config.row_y_tolerance,
            num_rows=self.config.num_spindle_rows,
        )
        deadline = time.monotonic() + self.config.rotation_timeout_seconds

        while not self.stop_event.is_set() and time.monotonic() < deadline:
            raw_dets = self._get_raw_detections(primary) if primary else []
            rotation_complete = tracker.add_frame(raw_dets)
            if rotation_complete or tracker.is_saturated():
                logger.info(
                    "ENTRY rotation complete: unique_rows=%d reason=%s",
                    tracker.total_count,
                    "repeat_row" if rotation_complete else "all_rows_seen",
                )
                break
            self._sleep(0.5)

        count = tracker.total_count
        if count == 0:
            return 0, {}

        checkpoint = self._process_checkpoint("entry", self.config.entry_cameras)
        return count, {**checkpoint, "deduplicated_count": count}

    def _get_raw_detections(self, camera_id: str) -> List[Dict[str, Any]]:
        """Return latest tracked detections from the continuous tracking stream."""
        ts = self.tracking_streams.get(camera_id)
        if ts is not None:
            return ts.get_latest_detections()
        capture = self.captures.get(camera_id)
        if capture is None or capture.last_model_frame is None:
            return []
        result = self.inference.detect(camera_id, capture.last_model_frame)
        return list(result.get("detections", []))

    # ------------------------------------------------------------------
    # Exit loop — runs on a dedicated daemon thread
    # ------------------------------------------------------------------

    def _exit_loop(self) -> None:
        """Detect spindle exits, offset by conveyor_travel_seconds.

        Starts after an initial delay equal to conveyor_travel_seconds so the
        first exit check aligns with when the first spindle reaches the exit
        cameras.  Thereafter it runs at the same spindle_gap_seconds cadence
        as the entry loop, keeping entry/exit pairs properly matched.
        """
        self._sleep(self.config.conveyor_travel_seconds)
        while not self.stop_event.is_set():
            if self.reconciler.depth == 0:
                self._sleep(0.5)
                continue
            self._run_exit()
            self._sleep(self.config.spindle_gap_seconds)

    def _run_exit(self) -> None:
        exit_result = self._process_checkpoint("exit", self.config.exit_cameras)
        reconciliation = self.reconciler.pop_exit(exit_result["deduplicated_count"])
        if reconciliation is None:
            logger.warning("Skipping exit publish because no FIFO entry was available")
            return
        self.publisher.publish_exit(
            {
                **exit_result,
                "spindle_pass_id": reconciliation["spindle_pass_id"],
                "session_id": reconciliation["session_id"],
                "entry_count": reconciliation["entry_count"],
                "exit_count": reconciliation["exit_count"],
                "reconciliation_status": reconciliation["status"],
                "mismatch_delta": reconciliation["mismatch_delta"],
            }
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _poll_active_session(self) -> Optional[str]:
        """Return the active production session ID from Supabase REST API.

        Falls back to the static ACTIVE_SESSION_ID env var when Supabase
        credentials are not configured (useful for local dev without Docker).
        """
        supabase_url = self.config.supabase_url
        supabase_key = self.config.supabase_service_key
        if not supabase_url or not supabase_key:
            return self.config.active_session_id or None

        url = (
            f"{supabase_url.rstrip('/')}/rest/v1/production_session"
            "?end_time=is.null&select=session_id&limit=1"
        )
        req = urllib.request.Request(
            url,
            headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                rows = json.loads(resp.read())
                return rows[0]["session_id"] if rows else None
        except Exception as exc:
            logger.warning("Failed to poll active session from Supabase: %s", exc)
            return None

    def stop(self) -> None:
        self.stop_event.set()
        for ts in self.tracking_streams.values():
            ts.stop()
        self.mjpeg_server.stop()
        self.inference.stop()
        for capture in self.captures.values():
            capture.release()
        self.publisher.close()
        logger.info("Edge orchestrator stopped")

    def _frame_reader_loop(self, capture: Any) -> None:
        """Read frames as fast as the source allows.

        File sources already pace themselves via _next_frame_time inside
        _capture_opencv (honours the original video fps).  Adding a second
        sleep here caused double-throttling that cut the effective rate in
        half.  RTSP sources block on av_read_frame(), so no sleep is needed
        there either.
        """
        while not self.stop_event.is_set():
            capture.capture_frame()
            if capture.last_frame is None:
                time.sleep(0.05)

    def _process_checkpoint(self, checkpoint: str, camera_ids: List[str]) -> Dict[str, Any]:
        detections_by_camera: Dict[str, List[Dict[str, Any]]] = {}
        raw_counts: Dict[str, int] = {}
        confidence_values: List[float] = []
        latencies: List[int] = []

        configured_camera_ids: List[str] = []

        for camera_id in camera_ids:
            capture = self.captures.get(camera_id)
            if capture is None:
                warning_key = (checkpoint, camera_id)
                if warning_key not in self._missing_checkpoint_cameras:
                    logger.warning(
                        "Skipping %s checkpoint camera %s because it has no configured source",
                        checkpoint,
                        camera_id,
                    )
                    self._missing_checkpoint_cameras.add(warning_key)
                continue

            configured_camera_ids.append(camera_id)

            if capture.last_model_frame is None:
                logger.warning("Camera %s has no cached frame yet; skipping", camera_id)
                continue

            result = self.inference.detect(camera_id, capture.last_model_frame)
            detections_by_camera[camera_id] = result["detections"]
            raw_counts[camera_id] = result["raw_count"]
            if result["filtered_count"]:
                confidence_values.append(result["confidence_avg"])
            latencies.append(result["latency_ms"])

        deduplicated_count = self.deduplicator.deduplicate_many(detections_by_camera)
        confidence_avg = (
            sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
        )
        latency_ms = int(sum(latencies) / len(latencies)) if latencies else 0
        logger.info(
            "%s checkpoint cameras=%s deduplicated_count=%s raw_counts=%s",
            checkpoint.upper(),
            configured_camera_ids,
            deduplicated_count,
            raw_counts,
        )
        return {
            "camera_ids": configured_camera_ids,
            "deduplicated_count": deduplicated_count,
            "raw_counts": raw_counts,
            "confidence_avg": round(confidence_avg, 4),
            "inference_latency_ms": latency_ms,
        }

    def _health_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                for camera_id, capture in self.captures.items():
                    status = "online" if capture.last_frame is not None else "offline"
                    self.publisher.publish_camera_health(camera_id, status, capture.actual_fps)
                self.publisher.publish_heartbeat(
                    self.config.active_session_id, self.reconciler.depth
                )
            except Exception as exc:
                logger.warning("Health publish failed: %s", exc)
            self._sleep(self.config.health_interval_seconds)

    def _sleep(self, seconds: float) -> None:
        self.stop_event.wait(seconds)


def main() -> None:
    config = load_config()
    orchestrator = EdgeOrchestrator(config)

    def handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Received signal %s", signum)
        orchestrator.stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    orchestrator.run_forever()


if __name__ == "__main__":
    main()
