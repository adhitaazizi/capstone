"""Cloudflare Realtime signaling client and aiortc helpers.

Shared by the subscriber half of the pipeline (pulls each camera's raw track)
and the publisher half (pushes the annotated track back). Ported from
capstone_inference.ipynb section 5.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

import aiohttp
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCRtpReceiver,
    RTCSessionDescription,
)

logger = logging.getLogger("inference.webrtc")

CF_BASE = "https://rtc.live.cloudflare.com/v1"


class CloudflareRealtimeAPI:
    def __init__(
        self,
        app_id: str,
        app_secret: str,
        base_url: str = CF_BASE,
    ):
        self.app_id = app_id
        self.app_secret = app_secret
        self.prefix = f"{base_url}/apps/{app_id}"
        self.session_id: Optional[str] = None

    async def _request(
        self,
        path: str,
        body: dict[str, Any],
        method: str = "POST",
    ) -> dict[str, Any]:
        url = f"{self.prefix}{path}"
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.app_secret}",
        }
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(
                method,
                url,
                headers=headers,
                json=body,
            ) as response:
                text = await response.text()
                try:
                    result = json.loads(text)
                except Exception as exc:
                    raise RuntimeError(
                        f"Cloudflare returned HTTP {response.status}: {text[:500]}"
                    ) from exc

                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(
                        f"Cloudflare returned HTTP {response.status}: {result}"
                    )
                self._check_errors(result)
                return result

    @staticmethod
    def _check_errors(result: dict[str, Any]) -> None:
        if result.get("errorCode"):
            raise RuntimeError(
                f"{result.get('errorCode')}: {result.get('errorDescription')}"
            )
        for index, track in enumerate(result.get("tracks", [])):
            if track.get("errorCode"):
                raise RuntimeError(
                    f"tracks[{index}] {track.get('errorCode')}: "
                    f"{track.get('errorDescription')}"
                )

    async def new_session(self, offer_sdp: str) -> dict[str, Any]:
        result = await self._request(
            "/sessions/new",
            {
                "sessionDescription": {
                    "type": "offer",
                    "sdp": offer_sdp,
                }
            },
        )
        self.session_id = result["sessionId"]
        return result

    async def new_tracks(
        self,
        tracks: list[dict[str, Any]],
        offer_sdp: Optional[str] = None,
    ) -> dict[str, Any]:
        if not self.session_id:
            raise RuntimeError("Cloudflare session has not been created.")
        body: dict[str, Any] = {"tracks": tracks}
        if offer_sdp is not None:
            body["sessionDescription"] = {
                "type": "offer",
                "sdp": offer_sdp,
            }
        return await self._request(
            f"/sessions/{self.session_id}/tracks/new",
            body,
        )

    async def renegotiate(self, answer_sdp: str) -> dict[str, Any]:
        if not self.session_id:
            raise RuntimeError("Cloudflare session has not been created.")
        return await self._request(
            f"/sessions/{self.session_id}/renegotiate",
            {
                "sessionDescription": {
                    "type": "answer",
                    "sdp": answer_sdp,
                }
            },
            method="PUT",
        )


async def resolve_ice_servers(
    cf_turn_key_id: str,
    cf_turn_key_token: str,
) -> "list[RTCIceServer]":
    """Build the ICE server list, preferring Cloudflare's TURN relay.

    Mirrors services/edge/main.py's CloudflarePublisher._ice_servers: plain
    STUN only tells a client its own NAT-mapped address, it does not relay
    media, so behind a NAT where the connectivity check can't reach that
    address directly, STUN alone can never connect (see
    services/edge/run-native.ps1 for the concrete case this bit this project).
    TURN credentials are a separate key pair from the Cloudflare app
    id/secret, created under "TURN" rather than "Realtime Applications".
    """
    default = [RTCIceServer(urls=["stun:stun.cloudflare.com:3478"])]

    if not cf_turn_key_id or not cf_turn_key_token:
        logger.info("CF_TURN_KEY_ID/TOKEN not set — using STUN only")
        return default

    url = f"{CF_BASE}/turn/keys/{cf_turn_key_id}/credentials/generate-ice-servers"
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(
                url,
                json={"ttl": 86400},
                headers={
                    "Authorization": f"Bearer {cf_turn_key_token}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                body = await resp.json()
                if resp.status >= 300:
                    raise RuntimeError(f"HTTP {resp.status}: {body}")
    except Exception as exc:
        logger.warning(
            "Failed to fetch TURN credentials from Cloudflare (%s); falling "
            "back to STUN only, which may not traverse a restrictive NAT.",
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

    logger.info(
        "Using %d Cloudflare-provided ICE server(s), including TURN", len(servers)
    )
    return servers


def rtc_configuration(
    ice_servers: "Optional[list[RTCIceServer]]" = None,
) -> RTCConfiguration:
    return RTCConfiguration(
        iceServers=ice_servers or [RTCIceServer(urls=["stun:stun.cloudflare.com:3478"])]
    )


def force_vp8(transceiver: Any) -> None:
    """Restrict a video transceiver to VP8 to avoid H.264 decoder stalls."""
    capabilities = RTCRtpReceiver.getCapabilities("video")
    vp8_codecs = [
        codec
        for codec in capabilities.codecs
        if codec.mimeType.casefold() == "video/vp8"
    ]
    if not vp8_codecs:
        raise RuntimeError("This aiortc build does not expose the VP8 codec.")
    transceiver.setCodecPreferences(vp8_codecs)


def force_all_video_transceivers_to_vp8(pc: RTCPeerConnection) -> None:
    for transceiver in pc.getTransceivers():
        if transceiver.kind == "video":
            force_vp8(transceiver)


async def wait_for_ice_gathering(
    pc: RTCPeerConnection,
    timeout_seconds: float = 20.0,
    stage: str = "ICE gathering",
) -> None:
    if pc.iceGatheringState == "complete":
        return

    event = asyncio.Event()

    @pc.on("icegatheringstatechange")
    async def _on_state_change() -> None:
        if pc.iceGatheringState == "complete":
            event.set()

    try:
        await asyncio.wait_for(event.wait(), timeout=timeout_seconds)
    except TimeoutError as exc:
        raise TimeoutError(
            f"{stage} timed out after {timeout_seconds:.0f}s "
            f"(iceGatheringState={pc.iceGatheringState})."
        ) from exc


async def set_complete_local_description(
    pc: RTCPeerConnection,
    description: RTCSessionDescription,
    stage: str = "local description",
) -> RTCSessionDescription:
    await pc.setLocalDescription(description)
    await wait_for_ice_gathering(pc, stage=f"{stage}: ICE gathering")
    if pc.localDescription is None:
        raise RuntimeError(f"{stage}: PeerConnection has no local description.")
    return pc.localDescription


async def wait_for_connection(
    pc: RTCPeerConnection,
    timeout_seconds: float = 60.0,
    stage: str = "WebRTC connection",
) -> None:
    def is_connected() -> bool:
        return (
            pc.connectionState == "connected"
            or pc.iceConnectionState in {"connected", "completed"}
        )

    if is_connected():
        return

    event = asyncio.Event()

    def report() -> None:
        logger.info(
            "%s: connection=%s, ICE=%s, signaling=%s",
            stage,
            pc.connectionState,
            pc.iceConnectionState,
            pc.signalingState,
        )
        if is_connected() or pc.connectionState in {"failed", "closed"}:
            event.set()
        elif pc.iceConnectionState in {"failed", "closed"}:
            event.set()

    @pc.on("connectionstatechange")
    async def _on_connection_state() -> None:
        report()

    @pc.on("iceconnectionstatechange")
    async def _on_ice_state() -> None:
        report()

    try:
        await asyncio.wait_for(event.wait(), timeout=timeout_seconds)
    except TimeoutError as exc:
        raise TimeoutError(
            f"{stage} timed out after {timeout_seconds:.0f}s "
            f"(connection={pc.connectionState}, ICE={pc.iceConnectionState}, "
            f"signaling={pc.signalingState})."
        ) from exc

    if not is_connected():
        raise RuntimeError(
            f"{stage} failed "
            f"(connection={pc.connectionState}, ICE={pc.iceConnectionState})."
        )


def description_from_result(result: dict[str, Any]) -> RTCSessionDescription:
    description = result["sessionDescription"]
    return RTCSessionDescription(
        sdp=description["sdp"],
        type=description["type"],
    )
