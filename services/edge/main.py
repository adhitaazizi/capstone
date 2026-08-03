"""Edge worker: publish cameras to Cloudflare Realtime via WebRTC,
receive Colab inference results via HTTP POST."""

from __future__ import annotations

import asyncio
import fractions
import json
import logging
import signal
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
from typing import Any, Dict, Optional

import aiohttp
import av
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("edge")

load_config = import_module("config").load_config
FrameCapture = import_module("frame_capture").FrameCapture


# ---------------------------------------------------------------------------
# Result store
# ---------------------------------------------------------------------------

class ResultStore:
    """Thread-safe store for Colab inference results and Cloudflare session info."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._results: Dict[str, Any] = {
            "rotation_number": 0,
            "updated_at": None,
            "counts": {},
        }
        self._session: Dict[str, Any] = {}

    def update_result(self, payload: Dict[str, Any]) -> None:
        cam = payload.get("camera_id", "unknown")
        with self._lock:
            self._results["counts"][cam] = {
                "count": payload.get("count", 0),
                "detections": payload.get("detections", []),
            }
            self._results["rotation_number"] += 1
            self._results["updated_at"] = datetime.now(timezone.utc).isoformat()
            if payload.get("processed_session_id"):
                self._session["processed_session_id"] = payload["processed_session_id"]
            if payload.get("processed_track_name"):
                self._session.setdefault("processed_tracks", {})[cam] = payload[
                    "processed_track_name"
                ]

    def set_publish_session(self, session_id: str, tracks: Dict[str, str]) -> None:
        with self._lock:
            self._session["publish_session_id"] = session_id
            self._session["publish_tracks"] = tracks

    def get_results(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._results)

    def get_session(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._session)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class _HTTPHandler(BaseHTTPRequestHandler):
    """POST /colab_result  |  GET /spindle_count  |  GET /cloudflare_session  |  GET /health"""

    def do_POST(self) -> None:
        if self.path != "/colab_result":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length))
            self.server.store.update_result(payload)
            self._json(200, {"status": "ok"})
        except Exception as exc:
            logger.warning("Bad /colab_result payload: %s", exc)
            self._json(400, {"error": str(exc)})

    def do_GET(self) -> None:
        if self.path == "/spindle_count":
            self._json(200, self.server.store.get_results())
        elif self.path == "/cloudflare_session":
            self._json(200, self.server.store.get_session())
        elif self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self.send_error(404)

    def _json(self, status: int, data: Any) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        pass  # silence per-request access log


# ---------------------------------------------------------------------------
# Cloudflare Realtime WebRTC publisher
# ---------------------------------------------------------------------------

def _make_camera_track_class() -> type:
    """Build the aiortc VideoStreamTrack subclass at runtime so the import
    only happens when aiortc is available."""
    from aiortc.mediastreams import VideoStreamTrack  # type: ignore[import-untyped]

    class CameraVideoTrack(VideoStreamTrack):
        def __init__(self, capture: Any, fps: int) -> None:
            super().__init__()
            self._capture = capture
            self._fps = fps
            self._pts = 0
            self._tb = fractions.Fraction(1, fps)

        async def recv(self) -> av.VideoFrame:
            await asyncio.sleep(1.0 / self._fps)
            raw: Optional[np.ndarray] = self._capture.last_model_frame
            if raw is None:
                raw = np.zeros((640, 640, 3), dtype=np.uint8)
            rgb = raw[:, :, ::-1]  # BGR → RGB
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame.pts = self._pts
            frame.time_base = self._tb
            self._pts += 1
            return frame

    return CameraVideoTrack


class CloudflarePublisher:
    CF_BASE = "https://rtc.live.cloudflare.com/v1"

    def __init__(self, config: Any, captures: Dict[str, Any], store: ResultStore) -> None:
        self._config = config
        self._captures = captures
        self._store = store

    async def run(self) -> None:
        from aiortc import RTCPeerConnection, RTCSessionDescription  # type: ignore[import-untyped]

        TrackClass = _make_camera_track_class()
        pc = RTCPeerConnection(
            configuration={"iceServers": [{"urls": ["stun:stun.cloudflare.com:3478"]}]}
        )

        mids: Dict[str, str] = {}
        for cam_id, cap in self._captures.items():
            track = TrackClass(cap, self._config.target_fps)
            tx = pc.addTransceiver(track, direction="sendonly")
            mids[cam_id] = tx.mid

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await self._wait_ice(pc)

        async with aiohttp.ClientSession() as http:
            # Create session
            data = await self._cf(http, "/sessions/new", {
                "sessionDescription": {
                    "type": pc.localDescription.type,
                    "sdp": pc.localDescription.sdp,
                }
            })
            session_id: str = data["sessionId"]
            await pc.setRemoteDescription(
                RTCSessionDescription(
                    sdp=data["sessionDescription"]["sdp"],
                    type=data["sessionDescription"]["type"],
                )
            )

            # Register named tracks
            track_names = self._config.camera_track_names
            tracks_payload = [
                {
                    "location": "local",
                    "mid": mids[cam_id],
                    "trackName": track_names.get(cam_id, cam_id.lower()),
                }
                for cam_id in self._captures
            ]
            tracks_data = await self._cf(
                http,
                f"/sessions/{session_id}/tracks/new",
                {"tracks": tracks_payload},
            )
            if tracks_data.get("sessionDescription"):
                await pc.setRemoteDescription(
                    RTCSessionDescription(
                        sdp=tracks_data["sessionDescription"]["sdp"],
                        type=tracks_data["sessionDescription"]["type"],
                    )
                )

        self._store.set_publish_session(
            session_id,
            {cam_id: track_names.get(cam_id, cam_id.lower()) for cam_id in self._captures},
        )
        logger.info("Cloudflare Realtime publishing. Session: %s", session_id)

        try:
            while True:
                await asyncio.sleep(30)
        except asyncio.CancelledError:
            pass
        finally:
            await pc.close()
            logger.info("Cloudflare Realtime connection closed")

    async def _wait_ice(self, pc: Any, timeout: float = 20.0) -> None:
        if pc.iceGatheringState == "complete":
            return
        ev = asyncio.Event()

        @pc.on("icegatheringstatechange")
        def _on_state() -> None:
            if pc.iceGatheringState == "complete":
                ev.set()

        try:
            await asyncio.wait_for(ev.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("ICE gathering timed out; proceeding with gathered candidates")

    async def _cf(
        self, http: aiohttp.ClientSession, path: str, body: Dict[str, Any]
    ) -> Dict[str, Any]:
        url = f"{self.CF_BASE}/apps/{self._config.cf_app_id}{path}"
        async with http.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {self._config.cf_app_secret}",
                "Content-Type": "application/json",
            },
        ) as resp:
            data: Dict[str, Any] = await resp.json()
        if data.get("errorCode"):
            raise RuntimeError(
                f"Cloudflare {path}: {data['errorCode']} — {data.get('errorDescription')}"
            )
        return data


# ---------------------------------------------------------------------------
# Frame reader and entry point
# ---------------------------------------------------------------------------

def _frame_reader_loop(capture: Any, stop: threading.Event) -> None:
    while not stop.is_set():
        capture.capture_frame()
        if capture.last_frame is None:
            time.sleep(0.05)


async def _publisher_main(
    config: Any,
    captures: Dict[str, Any],
    store: ResultStore,
    stop: threading.Event,
) -> None:
    publisher = CloudflarePublisher(config, captures, store)
    task = asyncio.ensure_future(publisher.run())

    # Yield control until the threading.Event is set (checked every 0.5 s)
    while not stop.is_set():
        await asyncio.sleep(0.5)

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def main() -> None:
    config = load_config()
    stop = threading.Event()

    captures: Dict[str, Any] = {
        cam_id: FrameCapture(cam_id, src, target_fps=config.target_fps)
        for cam_id, src in config.camera_sources.items()
    }
    for cap in captures.values():
        cap.open()

    for cap in captures.values():
        threading.Thread(
            target=_frame_reader_loop,
            args=(cap, stop),
            daemon=True,
        ).start()

    store = ResultStore()
    http_server = ThreadingHTTPServer(("0.0.0.0", config.http_port), _HTTPHandler)
    http_server.store = store  # type: ignore[attr-defined]
    threading.Thread(target=http_server.serve_forever, daemon=True).start()
    logger.info("HTTP server listening on :%d", config.http_port)

    def _handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Signal %d — shutting down", signum)
        stop.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    if config.cf_app_id and config.cf_app_secret:
        asyncio.run(_publisher_main(config, captures, store, stop))
    else:
        logger.warning(
            "CF_APP_ID / CF_APP_SECRET not set — HTTP server running, Cloudflare publishing disabled"
        )
        stop.wait()

    http_server.shutdown()
    for cap in captures.values():
        cap.release()
    logger.info("Edge worker stopped")


if __name__ == "__main__":
    main()
