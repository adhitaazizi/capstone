"""Lightweight MJPEG HTTP stream server."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

logger = logging.getLogger("mjpeg-server")


class MJPEGHandler(BaseHTTPRequestHandler):
    """Serve ``/stream/{camera_id}`` as multipart MJPEG."""

    frame_sources: Dict[str, Any] = {}

    def do_GET(self) -> None:
        parts = self.path.strip("/").split("/")
        if len(parts) != 2 or parts[0] != "stream":
            self.send_error(404)
            return

        camera_id = parts[1]
        source = self.frame_sources.get(camera_id)
        if source is None:
            self.send_error(404, f"Camera {camera_id} not found")
            return

        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            while True:
                jpeg_bytes = source.last_frame
                if jpeg_bytes is None:
                    time.sleep(1.0 / 15.0)
                    continue

                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(
                    f"X-Timestamp: {datetime.now(timezone.utc).isoformat()}\r\n".encode()
                )
                self.wfile.write(f"X-Camera-FPS: {source.actual_fps:.1f}\r\n".encode())
                self.wfile.write(f"Content-Length: {len(jpeg_bytes)}\r\n".encode())
                self.wfile.write(b"\r\n")
                self.wfile.write(jpeg_bytes)
                self.wfile.write(b"\r\n")
                time.sleep(1.0 / 15.0)
        except (BrokenPipeError, ConnectionResetError):
            logger.info("Client disconnected from %s stream", camera_id)

    def log_message(self, fmt: str, *args: Any) -> None:
        return


class MJPEGServer:
    """Background HTTP server for MJPEG camera streams."""

    def __init__(self, host: str = "0.0.0.0", port: int = 8080) -> None:
        self.host = host
        self.port = port
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self, frame_sources: Dict[str, Any]) -> None:
        MJPEGHandler.frame_sources = frame_sources
        self.server = ThreadingHTTPServer((self.host, self.port), MJPEGHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        logger.info("MJPEG server started on %s:%s", self.host, self.port)

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            logger.info("MJPEG server stopped")
