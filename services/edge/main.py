"""Edge worker: publish cameras to Cloudflare Realtime via WebRTC and register
that session with the Next.js app so Colab can discover it.

Counts do not flow through here. Colab posts raw detections straight to
Next.js, which owns all sampling and pairing logic.
"""

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

# Next.js marks a producer stale after two missed heartbeats.
HEARTBEAT_INTERVAL_SECONDS = 15

load_config = import_module("config").load_config
FrameCapture = import_module("frame_capture").FrameCapture


# ---------------------------------------------------------------------------
# Result store
# ---------------------------------------------------------------------------

class ResultStore:
    """Thread-safe record of which Cloudflare sessions this worker is publishing.

    One entry per camera: each camera negotiates its own independent
    Cloudflare Realtime session (see CloudflarePublisher for why sessions
    cannot be shared across cameras).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, Dict[str, str]] = {}
        self._updated_at: Optional[str] = None

    def set_publish_sessions(self, sessions: Dict[str, Dict[str, str]]) -> None:
        with self._lock:
            self._sessions = dict(sessions)
            self._updated_at = datetime.now(timezone.utc).isoformat()

    def get_session(self) -> Dict[str, Any]:
        with self._lock:
            return {"sessions": dict(self._sessions), "updated_at": self._updated_at}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class _HTTPHandler(BaseHTTPRequestHandler):
    """GET /cloudflare_session  |  GET /health

    Diagnostics only. The dashboard reads the session from Next.js, which the
    publisher registers with directly.
    """

    def do_GET(self) -> None:
        if self.path == "/cloudflare_session":
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


class CameraPublisher:
    """Publishes a single camera to its own, independent Cloudflare session.

    Each camera gets its own RTCPeerConnection rather than sharing one
    connection with multiple tracks. Bundling multiple tracks onto one
    connection does not work against Cloudflare Realtime: aiortc emits
    `a=group:BUNDLE` in the offer, but still negotiates a fully independent
    ICE session (distinct ice-ufrag/ice-pwd/candidates/sockets) for every
    m-line rather than sharing one transport the way a browser would. Since
    the offer nonetheless *claims* the m-lines are bundled, Cloudflare's
    answer only ever sets up a real ICE session for the first one, and every
    additional camera's connectivity checks reference an ICE session
    Cloudflare never created — they simply never succeed.
    Confirmed directly: two tracks on one connection failed ICE entirely
    ("ICE failed" after both candidate checks timed out); with a single track
    the identical code connected within two seconds.
    """

    def __init__(
        self,
        cam_id: str,
        capture: Any,
        config: Any,
        ice_servers: "list[Any]",
        track_class: type,
    ) -> None:
        self.cam_id = cam_id
        self.track_name = config.camera_track_names.get(cam_id, cam_id.lower())
        self.session_id: Optional[str] = None

        self._capture = capture
        self._config = config
        self._ice_servers = ice_servers
        self._track_class = track_class
        self._pc: Optional[Any] = None

    async def connect(self) -> None:
        from aiortc import (  # type: ignore[import-untyped]
            RTCConfiguration,
            RTCPeerConnection,
            RTCSessionDescription,
        )

        pc = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=self._ice_servers)
        )
        self._pc = pc

        track = self._track_class(self._capture, self._config.target_fps)
        # Keep the transceiver, not its mid: aiortc does not assign a mid
        # until setLocalDescription runs, so reading it earlier yields None and
        # Cloudflare rejects the track with "Body JSON validation error".
        transceiver = pc.addTransceiver(track, direction="sendonly")

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await _wait_ice(pc, self.cam_id)

        async with aiohttp.ClientSession() as http:
            data = await _cf(
                http,
                self._config,
                "/sessions/new",
                {
                    "sessionDescription": {
                        "type": pc.localDescription.type,
                        "sdp": pc.localDescription.sdp,
                    }
                },
            )
            session_id: str = data["sessionId"]
            await pc.setRemoteDescription(
                RTCSessionDescription(
                    sdp=data["sessionDescription"]["sdp"],
                    type=data["sessionDescription"]["type"],
                )
            )

            # Cloudflare rejects tracks/new with "Session is not ready yet"
            # until the PeerConnection has actually connected.
            await _wait_connected(pc, self.cam_id)

            mid = transceiver.mid
            if mid is None:
                raise RuntimeError(
                    f"No media MID was assigned for {self.cam_id}; cannot "
                    "register the track with Cloudflare."
                )

            tracks_data = await _cf(
                http,
                self._config,
                f"/sessions/{session_id}/tracks/new",
                {
                    "tracks": [
                        {
                            "location": "local",
                            "mid": mid,
                            "trackName": self.track_name,
                        }
                    ]
                },
            )
            if tracks_data.get("sessionDescription"):
                await pc.setRemoteDescription(
                    RTCSessionDescription(
                        sdp=tracks_data["sessionDescription"]["sdp"],
                        type=tracks_data["sessionDescription"]["type"],
                    )
                )

        self.session_id = session_id
        logger.info(
            "Cloudflare Realtime publishing %s. Session: %s", self.cam_id, session_id
        )

    async def close(self) -> None:
        if self._pc is not None:
            await self._pc.close()
            self._pc = None


class CloudflarePublisher:
    CF_BASE = "https://rtc.live.cloudflare.com/v1"

    def __init__(self, config: Any, captures: Dict[str, Any], store: ResultStore) -> None:
        self._config = config
        self._captures = captures
        self._store = store
        self._registered = False

    async def run(self) -> None:
        TrackClass = _make_camera_track_class()
        ice_servers = await self._ice_servers()

        publishers = [
            CameraPublisher(cam_id, cap, self._config, ice_servers, TrackClass)
            for cam_id, cap in self._captures.items()
        ]

        try:
            # Independent ICE sessions, so nothing serializes them — connect
            # every camera concurrently.
            await asyncio.gather(*(p.connect() for p in publishers))

            sessions = {
                p.cam_id: {"sessionId": p.session_id, "trackName": p.track_name}
                for p in publishers
            }
            self._store.set_publish_sessions(sessions)

            # Re-register on an interval rather than once: Next.js treats a
            # missed heartbeat as "this producer died", which is what lets the
            # dashboard distinguish a dead edge worker from a quiet one.
            while True:
                await self._register(sessions)
                await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            pass
        finally:
            await asyncio.gather(*(p.close() for p in publishers))
            logger.info("Cloudflare Realtime connections closed")

    async def _ice_servers(self) -> "list[Any]":
        """Build the ICE server list, preferring Cloudflare's TURN relay.

        Plain STUN only tells a client its own NAT-mapped address; it does not
        relay media. Behind a NAT where the connectivity check can't reach
        that address directly — the case on this network — STUN alone can
        never connect, and TURN (routing media through Cloudflare's own
        server) is the only thing that does. TURN credentials are a separate
        key pair from CF_APP_ID/CF_APP_SECRET, created under "TURN" rather
        than "Realtime Applications" in the Cloudflare dashboard.
        """
        from aiortc import RTCIceServer  # type: ignore[import-untyped]

        default = [RTCIceServer(urls=["stun:stun.cloudflare.com:3478"])]

        key_id = self._config.cf_turn_key_id
        key_token = self._config.cf_turn_key_token
        if not key_id or not key_token:
            logger.info("CF_TURN_KEY_ID/TOKEN not set — using STUN only")
            return default

        url = f"{self.CF_BASE}/turn/keys/{key_id}/credentials/generate-ice-servers"
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    url,
                    json={"ttl": 86400},
                    headers={
                        "Authorization": f"Bearer {key_token}",
                        "Content-Type": "application/json",
                    },
                ) as resp:
                    body = await resp.json()
                    if resp.status >= 300:
                        raise RuntimeError(f"HTTP {resp.status}: {body}")
        except Exception as exc:
            logger.warning(
                "Failed to fetch TURN credentials from Cloudflare (%s); "
                "falling back to STUN only, which will not traverse this NAT.",
                exc,
            )
            return default

        entries = body.get("iceServers", [])
        servers = [
            RTCIceServer(
                urls=entry["urls"],
                username=entry.get("username"),
                credential=entry.get("credential"),
            )
            for entry in entries
            if entry.get("urls")
        ]
        if not servers:
            logger.warning("Cloudflare returned no ICE servers; falling back to STUN only")
            return default

        logger.info("Using %d Cloudflare-provided ICE server(s), including TURN", len(servers))
        return servers

    async def _register(self, sessions: Dict[str, Dict[str, str]]) -> None:
        """Announce every camera's session to Next.js so Colab can discover them."""
        base_url = self._config.nextjs_base_url
        if not base_url:
            return
        if not self._config.inference_api_key:
            logger.warning(
                "INFERENCE_API_KEY is not set — cannot register source sessions. "
                "Colab will have to be given the session ids by hand."
            )
            return

        url = f"{base_url}/api/inference/register"
        payload = {"role": "source", "sessions": sessions}
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with http.post(
                    url,
                    json=payload,
                    headers={"x-inference-key": self._config.inference_api_key},
                ) as resp:
                    if resp.status >= 300:
                        body = await resp.text()
                        logger.warning(
                            "Source registration failed (HTTP %d): %s",
                            resp.status,
                            body[:200],
                        )
                    elif not self._registered:
                        self._registered = True
                        logger.info("Source sessions registered with %s", base_url)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Never fatal: the camera stream matters more than the registration,
            # and the next heartbeat retries anyway.
            logger.warning("Source registration to %s failed: %s", url, exc)


async def _wait_connected(pc: Any, cam_id: str, timeout: float = 90.0) -> None:
    # ICE tries candidates highest-priority first, and private host addresses
    # (e.g. 192.168.x.x) score higher than the public STUN-derived (srflx)
    # address per RFC 8445 — even though only the srflx address can ever
    # actually reach Cloudflare. Each unreachable host candidate has to
    # exhaust its retransmission timeout (RFC 8445 default: up to ~40s) before
    # ICE falls through to the srflx pair, so 30s was too short to ever see it
    # succeed. (In practice srflx does not work either — see CameraPublisher's
    # docstring for why every camera needs its own connection and, on
    # networks like this one, a TURN relay.)
    def connected() -> bool:
        return (
            pc.connectionState == "connected"
            or pc.iceConnectionState in {"connected", "completed"}
        )

    if connected():
        return

    ev = asyncio.Event()

    def _check() -> None:
        if connected() or pc.connectionState in {"failed", "closed"}:
            ev.set()

    pc.on("connectionstatechange", _check)
    pc.on("iceconnectionstatechange", _check)

    try:
        await asyncio.wait_for(ev.wait(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"[{cam_id}] PeerConnection did not connect within {timeout:.0f}s "
            f"(connection={pc.connectionState}, ICE={pc.iceConnectionState})"
        ) from exc

    if not connected():
        raise RuntimeError(
            f"[{cam_id}] PeerConnection failed "
            f"(connection={pc.connectionState}, ICE={pc.iceConnectionState})"
        )
    logger.info("[%s] PeerConnection connected to Cloudflare", cam_id)


async def _wait_ice(pc: Any, cam_id: str, timeout: float = 20.0) -> None:
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
        logger.warning(
            "[%s] ICE gathering timed out; proceeding with gathered candidates",
            cam_id,
        )


async def _cf(
    http: aiohttp.ClientSession, config: Any, path: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    url = f"{CloudflarePublisher.CF_BASE}/apps/{config.cf_app_id}{path}"
    async with http.post(
        url,
        json=body,
        headers={
            "Authorization": f"Bearer {config.cf_app_secret}",
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

    # Yield control until the threading.Event is set (checked every 0.5 s).
    # The task is polled rather than ignored: an exception inside run() would
    # otherwise sit unretrieved in the future and the worker would look healthy
    # while silently publishing nothing.
    while not stop.is_set():
        if task.done():
            exc = task.exception()
            if exc is not None:
                logger.error("Cloudflare publisher failed", exc_info=exc)
            else:
                logger.error("Cloudflare publisher exited unexpectedly")
            return
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

    # Signal the reader threads before releasing their captures, otherwise they
    # keep polling a closed capture and spray "capture requested before open".
    stop.set()
    http_server.shutdown()
    for cap in captures.values():
        cap.release()
    logger.info("Edge worker stopped")


if __name__ == "__main__":
    main()
