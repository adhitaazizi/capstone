"""Configuration for the simulated edge-compute service."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Dict, List

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class EdgeConfig:
    rabbitmq_url: str
    roboflow_api_key: str
    roboflow_project: str
    roboflow_version: str
    active_session_id: str
    camera_sources: Dict[str, str]
    entry_cameras: List[str]
    exit_cameras: List[str]
    mjpeg_port: int
    health_interval_seconds: int
    conveyor_travel_seconds: float
    spindle_gap_seconds: float
    target_fps: int


def load_config() -> EdgeConfig:
    """Load all edge configuration from environment variables."""

    camera_sources = _load_camera_sources()
    return EdgeConfig(
        rabbitmq_url=os.environ.get("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/%2F"),
        roboflow_api_key=os.environ.get("ROBOFLOW_API_KEY", ""),
        roboflow_project=os.environ.get("ROBOFLOW_PROJECT", ""),
        roboflow_version=os.environ.get("ROBOFLOW_VERSION", "1"),
        active_session_id=os.environ.get("ACTIVE_SESSION_ID", "demo-session"),
        camera_sources=camera_sources,
        entry_cameras=_csv_env("ENTRY_CAMERAS", ["CAM-01", "CAM-02"]),
        exit_cameras=_csv_env("EXIT_CAMERAS", ["CAM-03", "CAM-04"]),
        mjpeg_port=int(os.environ.get("MJPEG_PORT", "8080")),
        health_interval_seconds=int(os.environ.get("HEALTH_INTERVAL_SECONDS", "5")),
        conveyor_travel_seconds=float(os.environ.get("CONVEYOR_TRAVEL_SECONDS", "3")),
        spindle_gap_seconds=float(os.environ.get("SPINDLE_GAP_SECONDS", "5")),
        target_fps=int(os.environ.get("TARGET_FPS", "30")),
    )


def _load_camera_sources() -> Dict[str, str]:
    raw = os.environ.get("CAMERA_SOURCES")
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("CAMERA_SOURCES must be a JSON object") from exc
        if not isinstance(parsed, dict):
            raise ValueError("CAMERA_SOURCES must be a JSON object")
        return {str(camera_id): str(source) for camera_id, source in parsed.items()}

    return {
        "CAM-01": os.environ.get("CAM_01_SOURCE", "/data/test_videos/cam01.mp4"),
        "CAM-02": os.environ.get("CAM_02_SOURCE", "/data/test_videos/cam02.mp4"),
        "CAM-03": os.environ.get("CAM_03_SOURCE", "/data/test_videos/cam03.mp4"),
        "CAM-04": os.environ.get("CAM_04_SOURCE", "/data/test_videos/cam04.mp4"),
    }


def _csv_env(name: str, default: List[str]) -> List[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]
