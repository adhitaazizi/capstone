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

        frame_delay = 1.0 / max(config.target_fps, 1)
        while not stop_event.is_set():
            for capture in captures.values():
                capture.capture_frame()
            stop_event.wait(frame_delay)
    finally:
        server.stop()
        for capture in captures.values():
            capture.release()
        logger.info("RTSP bridge stopped")


if __name__ == "__main__":
    main()
