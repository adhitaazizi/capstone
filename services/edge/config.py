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
