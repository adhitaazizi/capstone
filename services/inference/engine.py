"""RF-DETR inference and annotation against the newest frame of each camera.

Runs inference and annotation only. It emits every detection it finds, in
frame-normalized coordinates, and makes no judgement about which toys
"belong" to the spindle — that decision, along with all interval sampling,
lives server-side in Next.js (lib/inference/boundary.ts,
lib/inference/aggregator.ts) so it can be tuned without touching this worker.

Ported from capstone_inference.ipynb section 6.
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import av
import numpy as np
from aiortc import MediaStreamTrack
from PIL import Image, ImageDraw, ImageFont
from rfdetr import RFDETR


@dataclass
class CameraPipelineStats:
    camera_id: str
    camera_name: str
    source_track_name: str
    output_track_name: str
    received_frames: int = 0
    processed_frames: int = 0
    last_inference_ms: float = 0.0
    last_object_count: int = 0
    started_at: float = 0.0

    @property
    def uptime_seconds(self) -> float:
        return max(0.0, time.monotonic() - self.started_at)

    @property
    def processed_fps(self) -> float:
        if self.uptime_seconds <= 0:
            return 0.0
        return self.processed_frames / self.uptime_seconds


class LatestFrameBuffer:
    """Continuously consumes a source and retains only its newest frame."""

    def __init__(self, source: MediaStreamTrack, stats: CameraPipelineStats):
        self.source = source
        self.stats = stats
        self._latest: Optional[av.VideoFrame] = None
        self._sequence = 0
        self._event = asyncio.Event()
        self._exception: Optional[BaseException] = None
        self._task = asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        try:
            while True:
                frame = await self.source.recv()
                self.stats.received_frames += 1
                self._latest = frame
                self._sequence += 1
                self._event.set()
        except BaseException as exc:
            self._exception = exc
            self._event.set()

    @property
    def has_frame(self) -> bool:
        """True once at least one frame has decoded. Drives the keyframe
        watchdog in pipeline.py, which stops nudging the publisher as soon as
        the stream actually produces frames."""
        return self._latest is not None

    async def newest_after(self, previous_sequence: int) -> tuple[int, av.VideoFrame]:
        while True:
            if self._exception is not None:
                raise self._exception
            if self._latest is not None and self._sequence > previous_sequence:
                return self._sequence, self._latest
            self._event.clear()
            await self._event.wait()

    async def wait_for_first_frame(self, timeout_seconds: float = 60.0) -> av.VideoFrame:
        try:
            _, frame = await asyncio.wait_for(
                self.newest_after(0), timeout=timeout_seconds
            )
            return frame
        except TimeoutError as exc:
            raise TimeoutError(
                f"No decodable video frame arrived for "
                f"{self.stats.camera_name} / {self.stats.source_track_name} "
                f"within {timeout_seconds:.0f}s. "
                "Keep the browser publisher publishing (see /cameras) and use VP8."
            ) from exc

    async def close(self) -> None:
        self._task.cancel()
        try:
            await self._task
        except BaseException:
            pass


class RFDETRStreamingEngine:
    """A single shared RF-DETR model used safely by all camera tracks."""

    def __init__(
        self,
        model: RFDETR,
        model_class_names: list[str],
        confidence: float,
        max_detections: int,
        target_class_names: Optional[frozenset[str]],
        inference_shape: Optional[tuple[int, int]],
    ):
        self.model = model
        self.model_class_names = model_class_names
        self.confidence = confidence
        self.max_detections = max_detections
        self.target_class_names = target_class_names
        self.inference_shape = inference_shape
        self._lock = threading.Lock()

    def process(
        self,
        rgb: np.ndarray,
        camera_name: str,
    ) -> tuple[np.ndarray, float, int, list[dict[str, Any]]]:
        # RF-DETR expects NumPy images in RGB channel order. It returns boxes
        # in the source image coordinate system, so annotation can stay
        # full-size.
        predict_kwargs: dict[str, Any] = {
            "threshold": self.confidence,
            "include_source_image": False,
        }
        if self.inference_shape is not None:
            predict_kwargs["shape"] = self.inference_shape

        # A shared model is serialized because simultaneous predict() calls
        # on one instance are not assumed to be thread-safe.
        with self._lock:
            started_at = time.perf_counter()
            detections = self.model.predict(
                np.ascontiguousarray(rgb),
                **predict_kwargs,
            )
            latency_ms = (time.perf_counter() - started_at) * 1000.0

        boxes = np.asarray(detections.xyxy, dtype=np.float32)
        detection_count = len(boxes)

        if detections.confidence is None:
            confidences = np.ones(detection_count, dtype=np.float32)
        else:
            confidences = np.asarray(detections.confidence, dtype=np.float32)

        if detections.class_id is None:
            class_ids = np.full(detection_count, -1, dtype=np.int32)
        else:
            class_ids = np.asarray(detections.class_id, dtype=np.int32)

        raw_class_names = detections.data.get("class_name")
        if raw_class_names is not None and len(raw_class_names) == detection_count:
            class_names = np.asarray(
                [str(name) for name in raw_class_names], dtype=object
            )
        else:
            class_names = np.asarray(
                [
                    self.model_class_names[class_id]
                    if 0 <= class_id < len(self.model_class_names)
                    else f"class-{class_id}"
                    for class_id in class_ids
                ],
                dtype=object,
            )

        if self.target_class_names is not None and detection_count:
            class_mask = np.asarray(
                [
                    str(name).casefold() in self.target_class_names
                    for name in class_names
                ],
                dtype=bool,
            )
            boxes = boxes[class_mask]
            confidences = confidences[class_mask]
            class_ids = class_ids[class_mask]
            class_names = class_names[class_mask]

        if len(boxes) > self.max_detections:
            selected = np.argsort(confidences)[::-1][: self.max_detections]
            boxes = boxes[selected]
            confidences = confidences[selected]
            class_ids = class_ids[selected]
            class_names = class_names[selected]

        object_count = len(boxes)
        image = Image.fromarray(rgb.copy())
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default()
        image_width, image_height = image.size

        # Normalized by frame dimensions so the server never has to know the
        # source resolution, and a camera swap cannot silently shift every
        # box.
        payload: list[dict[str, Any]] = []

        for box, confidence, class_name in zip(boxes, confidences, class_names):
            x1, y1, x2, y2 = [float(value) for value in box]

            payload.append(
                {
                    "cls": str(class_name),
                    "conf": round(float(confidence), 4),
                    "box": [
                        round(x1 / image_width, 5),
                        round(y1 / image_height, 5),
                        round(x2 / image_width, 5),
                        round(y2 / image_height, 5),
                    ],
                }
            )

            x1 = int(max(0, min(image_width - 1, round(x1))))
            y1 = int(max(0, min(image_height - 1, round(y1))))
            x2 = int(max(0, min(image_width - 1, round(x2))))
            y2 = int(max(0, min(image_height - 1, round(y2))))

            # Spindles get their own colour so the operator can see the
            # region the server is measuring toys against.
            is_spindle = str(class_name).casefold() == "spindle"
            colour = (60, 200, 255) if is_spindle else (255, 60, 60)

            label = f"{class_name} {float(confidence):.2f}"
            label_y = max(0, y1 - 16)
            text_box = draw.textbbox((x1, label_y), label, font=font)

            draw.rectangle((x1, y1, x2, y2), outline=colour, width=3)
            draw.rectangle(
                (
                    text_box[0] - 2,
                    text_box[1] - 2,
                    text_box[2] + 2,
                    text_box[3] + 2,
                ),
                fill=colour,
            )
            draw.text((x1, label_y), label, fill=(255, 255, 255), font=font)

        status = (
            f"RF-DETR M | {camera_name} | objects: {object_count} | "
            f"inference: {latency_ms:.1f} ms"
        )
        status_box = draw.textbbox((8, 8), status, font=font)
        draw.rectangle(
            (4, 4, status_box[2] + 12, status_box[3] + 12), fill=(0, 0, 0)
        )
        draw.text((8, 8), status, fill=(255, 255, 255), font=font)

        return np.asarray(image), latency_ms, object_count, payload


class RFDETRProcessedVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(
        self,
        source_buffer: LatestFrameBuffer,
        engine: RFDETRStreamingEngine,
        stats: CameraPipelineStats,
        reporter: Optional[Any] = None,
    ):
        super().__init__()
        self.source_buffer = source_buffer
        self.engine = engine
        self.stats = stats
        self.reporter = reporter
        self._last_sequence = 0

    async def recv(self) -> av.VideoFrame:
        sequence, source_frame = await self.source_buffer.newest_after(
            self._last_sequence
        )
        self._last_sequence = sequence

        source_rgb = source_frame.to_ndarray(format="rgb24")
        annotated_rgb, latency_ms, object_count, payload = await asyncio.to_thread(
            self.engine.process,
            source_rgb,
            self.stats.camera_name,
        )

        self.stats.processed_frames += 1
        self.stats.last_inference_ms = latency_ms
        self.stats.last_object_count = object_count

        # Buffered, never awaited: reporting must not be able to stall the
        # video track if Next.js is slow or unreachable.
        if self.reporter is not None:
            self.reporter.push(time.time() * 1000.0, latency_ms, payload)

        output_frame = av.VideoFrame.from_ndarray(annotated_rgb, format="rgb24")
        output_frame.pts = source_frame.pts
        output_frame.time_base = source_frame.time_base
        return output_frame
