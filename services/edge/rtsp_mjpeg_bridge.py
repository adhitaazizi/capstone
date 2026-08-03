"""RTSP to MJPEG bridge for browser-based camera testing."""

from __future__ import annotations

import logging
import signal
import threading
import time

from config import load_config
from frame_capture import FrameCapture
from mjpeg_server import MJPEGServer


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("rtsp-mjpeg-bridge")


def _capture_loop(capture: FrameCapture, stop_event: threading.Event, target_fps: int) -> None:
    """Capture frames for a single camera continuously on its own thread.

    PyAV blocks in av_read_frame() until the next RTSP packet arrives, so no
    artificial sleep is needed — that would only cause buffer accumulation and
    frame-skip artefacts on the viewer side.
    """
    while not stop_event.is_set():
        try:
            b64, _ = capture.capture_frame()
            if b64 is None:
                # Stream unavailable — wait before retrying so we don't spin at 100% CPU
                time.sleep(2.0)
        except Exception as exc:
            logger.warning("Camera %s unexpected error in capture loop: %s", capture.camera_id, exc)
            capture.release()
            time.sleep(2.0)


def main() -> None:
    config = load_config()
    stop_event = threading.Event()
    captures = {
        camera_id: FrameCapture(camera_id, source, target_fps=config.target_fps)
        for camera_id, source in config.camera_sources.items()
    }
    server = MJPEGServer(port=config.mjpeg_port)

    def handle_signal(signum: int, _frame: object) -> None:
        logger.info("Received signal %s", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        for capture in captures.values():
            capture.open()

        server.start(captures)
        logger.info("RTSP bridge started for cameras=%s", sorted(captures))

        threads = [
            threading.Thread(
                target=_capture_loop,
                args=(capture, stop_event, 0),
                daemon=True,
                name=f"capture-{camera_id}",
            )
            for camera_id, capture in captures.items()
        ]
        for t in threads:
            t.start()

        stop_event.wait()
    finally:
        server.stop()
        for capture in captures.values():
            capture.release()
        logger.info("RTSP bridge stopped")


if __name__ == "__main__":
    main()
