"""OpenCV frame capture for edge camera streams.

Production sources can be USB devices such as ``/dev/video0``. Development and
Docker simulation use mounted video files under ``/data/test_videos``. Captured
frames are resized to 640x640, JPEG encoded, and base64 encoded for Roboflow;
the latest JPEG bytes are retained for MJPEG streaming.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Optional, Tuple

import cv2

logger = logging.getLogger("frame-capture")


class FrameCapture:
    """Capture frames from a camera device or video file."""

    def __init__(self, camera_id: str, source: str, target_fps: int = 30) -> None:
        self.camera_id = camera_id
        self.source = source
        self.target_fps = target_fps
        self.cap: Optional[cv2.VideoCapture] = None
        self.last_frame: Optional[bytes] = None
        self.actual_fps = 0.0
        self._frames_seen = 0
        self._fps_started_at = time.monotonic()

    def open(self) -> None:
        """Open the configured video source."""

        if self.source.startswith("/dev/"):
            self.cap = cv2.VideoCapture(self.source, cv2.CAP_V4L2)
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
            self.cap.set(cv2.CAP_PROP_FPS, self.target_fps)
        else:
            self.cap = cv2.VideoCapture(self.source)

        if self.cap is None or not self.cap.isOpened():
            raise RuntimeError(f"Cannot open camera {self.camera_id} source: {self.source}")

        logger.info("Camera %s opened: %s", self.camera_id, self.source)

    def capture_frame(self) -> Tuple[Optional[str], Optional[bytes]]:
        """Capture one frame.

        Returns:
            Tuple of ``(base64_encoded_jpeg, resized_jpeg_bytes)``. Both values
            are ``None`` when the source cannot produce a frame.
        """

        if self.cap is None or not self.cap.isOpened():
            logger.warning("Camera %s capture requested before open", self.camera_id)
            return None, None

        ok, frame = self.cap.read()
        if not ok:
            if not self.source.startswith("/dev/"):
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.cap.read()
            if not ok:
                logger.warning("Camera %s failed to read frame", self.camera_id)
                return None, None

        resized = cv2.resize(frame, (640, 640))
        resized_ok, resized_jpeg = cv2.imencode(
            ".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85]
        )
        stream_ok, stream_jpeg = cv2.imencode(
            ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80]
        )
        if not resized_ok or not stream_ok:
            logger.warning("Camera %s failed to JPEG encode frame", self.camera_id)
            return None, None

        resized_bytes = resized_jpeg.tobytes()
        self.last_frame = stream_jpeg.tobytes()
        self._record_frame()
        return base64.b64encode(resized_bytes).decode("utf-8"), resized_bytes

    def release(self) -> None:
        """Release the OpenCV capture handle."""

        if self.cap is not None:
            self.cap.release()
            logger.info("Camera %s released", self.camera_id)

    def _record_frame(self) -> None:
        self._frames_seen += 1
        elapsed = time.monotonic() - self._fps_started_at
        if elapsed >= 1.0:
            self.actual_fps = self._frames_seen / elapsed
            self._frames_seen = 0
            self._fps_started_at = time.monotonic()
