"""Configuration for the edge-compute service."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from dotenv import load_dotenv

_ = load_dotenv()


@dataclass(frozen=True)
class EdgeConfig:
    camera_sources: dict[str, str]
    camera_track_names: dict[str, str]
    target_fps: int
    http_port: int
    cf_app_id: str
    cf_app_secret: str
    # Separate credential pair from cf_app_id/cf_app_secret, created under
    # "TURN" in the Cloudflare dashboard rather than "Realtime Applications".
    # Required whenever the publisher sits behind a NAT that direct
    # STUN-based ICE cannot traverse (see run-native.ps1 for why that happens
    # on this network). Optional: an empty value falls back to STUN only.
    cf_turn_key_id: str
    cf_turn_key_token: str
    # Where to register the Cloudflare source session so Colab can discover it
    # without anything being pasted by hand. Same Docker network, so this is the
    # service name rather than the public tunnel URL Colab uses.
    nextjs_base_url: str
    inference_api_key: str


def load_config() -> EdgeConfig:
    camera_sources = _load_camera_sources()

    raw_track_names = os.environ.get("CF_TRACK_NAMES", "")
    if raw_track_names:
        try:
            track_names: dict[str, str] = json.loads(raw_track_names)
        except json.JSONDecodeError:
            track_names = {}
    else:
        track_names = {cam_id: cam_id.lower() for cam_id in camera_sources}

    return EdgeConfig(
        camera_sources=camera_sources,
        camera_track_names=track_names,
        target_fps=int(os.environ.get("TARGET_FPS", "15")),
        http_port=int(os.environ.get("HTTP_PORT", "8081")),
        cf_app_id=os.environ.get("CF_APP_ID", "").strip(),
        cf_app_secret=os.environ.get("CF_APP_SECRET", "").strip(),
        cf_turn_key_id=os.environ.get("CF_TURN_KEY_ID", "").strip(),
        cf_turn_key_token=os.environ.get("CF_TURN_KEY_TOKEN", "").strip(),
        nextjs_base_url=os.environ.get(
            "NEXTJS_INTERNAL_URL", "http://nextjs:3000"
        ).rstrip("/"),
        inference_api_key=os.environ.get("INFERENCE_API_KEY", "").strip(),
    )


def _load_camera_sources() -> dict[str, str]:
    raw = os.environ.get("CAMERA_SOURCES")
    if raw:
        try:
            parsed: object = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("CAMERA_SOURCES must be a JSON object") from exc
        if not isinstance(parsed, dict):
            raise ValueError("CAMERA_SOURCES must be a JSON object")
        return {str(k): str(v) for k, v in parsed.items()}

    return {
        "CAM-01": os.environ.get("CAM_01_SOURCE", "/app/video/pov1.mp4"),
        "CAM-02": os.environ.get("CAM_02_SOURCE", "/app/video/pov2.mov"),
    }
