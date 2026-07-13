"""Frame capture for edge camera streams.

RTSP streams use PyAV (libav) which releases the GIL during av_read_frame()
I/O, allowing all four camera threads to run concurrently. HLS and file
sources keep the existing OpenCV path.

Captured frames are resized to 640x640, JPEG encoded, and base64 encoded for
Roboflow; the latest JPEG bytes are retained for MJPEG streaming.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

import av
import cv2
import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger("frame-capture")

RTSP_TIMEOUT_MS = 15000


class FrameCapture:
    """Capture frames from an RTSP stream or video file."""

    def __init__(self, camera_id: str, source: str, target_fps: int = 30) -> None:
        self.camera_id: str = camera_id
        self.source: str = source
        self.target_fps: int = target_fps
        self.cap: cv2.VideoCapture | None = None
        self._av_container: av.container.InputContainer | None = None
        self._av_demux: Any = None
        self.last_frame: bytes | None = None
        self.last_model_frame: NDArray[np.uint8] | None = None
        self.actual_fps: float = 0.0
        self._frames_seen: int = 0
        self._fps_started_at: float = time.monotonic()

    def open(self) -> None:
        """Open the configured video source."""
        if self._is_rtsp_source:
            try:
                self._av_container = av.open(
                    self.source,
                    options={
                        "rtsp_transport": "tcp",
                        "max_analyze_duration": "500000",
                    },
                )
                self._av_demux = self._av_container.demux(video=0)
                logger.info("Camera %s opened: %s", self.camera_id, self.source)
            except Exception as exc:
                logger.warning(
                    "Camera %s live source is offline: %s (%s)",
                    self.camera_id, self.source, exc,
                )
                self._av_container = None
                self._av_demux = None
        elif self._is_hls_source:
            self.cap = cv2.VideoCapture(
                self.source,
                cv2.CAP_FFMPEG,
                [
                    cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000,
                    cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_MS,
                ],
            )
            if self.cap is None or not self.cap.isOpened():
                logger.warning(
                    "Camera %s live source is offline: %s", self.camera_id, self.source
                )
                self.cap = None
            else:
                logger.info("Camera %s opened: %s", self.camera_id, self.source)
        else:
            self.cap = cv2.VideoCapture(self.source)
            if self.cap is None or not self.cap.isOpened():
                raise RuntimeError(
                    f"Cannot open camera {self.camera_id} source: {self.source}"
                )
            logger.info("Camera %s opened: %s", self.camera_id, self.source)

    def capture_frame(self) -> tuple[str | None, bytes | None]:
        """Capture one frame.

        Returns:
            Tuple of ``(base64_encoded_jpeg, resized_jpeg_bytes)``. Both values
            are ``None`` when the source cannot produce a frame.
        """
        if self._is_rtsp_source:
            return self._capture_rtsp_pyav()
        return self._capture_opencv()

    def release(self) -> None:
        """Release all capture handles."""
        if self._av_container is not None:
            self._av_container.close()
            self._av_container = None
            self._av_demux = None
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        logger.info("Camera %s released", self.camera_id)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _capture_rtsp_pyav(self) -> tuple[str | None, bytes | None]:
        """Read one decoded video frame via PyAV.

        PyAV releases the GIL during av_read_frame() network I/O so all four
        camera threads can proceed without starving each other.
        """
        if self._av_container is None:
            self.open()
            if self._av_container is None:
                return None, None

        try:
            while True:
                packet = next(self._av_demux)
                for frame in packet.decode():
                    img = frame.to_ndarray(format="bgr24")
                    return self._encode_frame(img)
        except StopIteration:
            logger.warning("Camera %s RTSP stream ended; reopening", self.camera_id)
            self.release()
            return None, None
        except Exception as exc:
            logger.warning(
                "Camera %s RTSP read error: %s; reopening", self.camera_id, exc
            )
            self.release()
            return None, None

    def _capture_opencv(self) -> tuple[str | None, bytes | None]:
        """Read one frame via OpenCV (HLS and file sources)."""
        if self.cap is None or not self.cap.isOpened():
            if self._is_live_source:
                self.open()
                if self.cap is None or not self.cap.isOpened():
                    return None, None
            else:
                logger.warning(
                    "Camera %s capture requested before open", self.camera_id
                )
                return None, None

        if self.cap is None:
            return None, None

        ok, frame = self.cap.read()
        if not ok:
            if self._is_file_source:
                _ = self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.cap.read()
            elif self._is_live_source:
                logger.warning(
                    "Camera %s lost live stream frame; reopening", self.camera_id
                )
                self.release()
                self.open()
                if self.cap is None or not self.cap.isOpened():
                    return None, None
                ok, frame = self.cap.read()
            if not ok:
                logger.warning("Camera %s failed to read frame", self.camera_id)
                return None, None

        return self._encode_frame(frame)

    def _encode_frame(self, frame: Any | None) -> tuple[str | None, bytes | None]:
        if frame is None:
            logger.warning("Camera %s returned an empty frame", self.camera_id)
            return None, None

        frame = np.asarray(frame)
        resized = cv2.resize(frame, (640, 640))
        self.last_model_frame = resized
        resized_ok, resized_jpeg = cv2.imencode(
            ".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85]
        )
        h, w = frame.shape[:2]
        if w > 640:
            display = cv2.resize(frame, (640, int(h * 640 / w)))
        else:
            display = frame
        stream_ok, stream_jpeg = cv2.imencode(
            ".jpg", display, [cv2.IMWRITE_JPEG_QUALITY, 80]
        )
        if not resized_ok or not stream_ok:
            logger.warning("Camera %s failed to JPEG encode frame", self.camera_id)
            return None, None

        resized_bytes = resized_jpeg.tobytes()
        self.last_frame = stream_jpeg.tobytes()
        self._record_frame()
        return base64.b64encode(resized_bytes).decode("utf-8"), resized_bytes

    def _record_frame(self) -> None:
        self._frames_seen += 1
        elapsed = time.monotonic() - self._fps_started_at
        if elapsed >= 1.0:
            self.actual_fps = self._frames_seen / elapsed
            self._frames_seen = 0
            self._fps_started_at = time.monotonic()

    @property
    def _is_rtsp_source(self) -> bool:
        return self.source.startswith(("rtsp://", "rtsps://"))

    @property
    def _is_hls_source(self) -> bool:
        return self.source.startswith(("http://", "https://"))

    @property
    def _is_live_source(self) -> bool:
        return self._is_rtsp_source or self._is_hls_source

    @property
    def _is_file_source(self) -> bool:
        return not self._is_live_source
