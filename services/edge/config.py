"""Configuration for the simulated edge-compute service."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import cast

from dotenv import load_dotenv

_ = load_dotenv()


@dataclass(frozen=True)
class EdgeConfig:
    rabbitmq_url: str
    roboflow_api_url: str
    roboflow_api_key: str
    roboflow_workspace: str
    roboflow_workflow: str
    roboflow_image_input: str
    roboflow_stream_outputs: list[str]
    roboflow_data_outputs: list[str]
    roboflow_processing_timeout: int
    roboflow_requested_plan: str | None
    roboflow_requested_region: str | None
    confidence_threshold: float
    active_session_id: str
    camera_sources: dict[str, str]
    entry_cameras: list[str]
    exit_cameras: list[str]
    mjpeg_port: int
    health_interval_seconds: int
    conveyor_travel_seconds: float
    spindle_gap_seconds: float
    target_fps: int
    roboflow_model_project: str
    roboflow_model_version: str
    supabase_url: str
    supabase_service_key: str
    mock_spindle_count: int | None


def load_config() -> EdgeConfig:
    """Load all edge configuration from environment variables."""

    camera_sources = _load_camera_sources()
    return EdgeConfig(
        rabbitmq_url=os.environ.get("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/%2F"),
        roboflow_api_url=os.environ.get("ROBOFLOW_API_URL", "https://serverless.roboflow.com"),
        roboflow_api_key=os.environ.get("ROBOFLOW_API_KEY", ""),
        roboflow_workspace=os.environ.get("ROBOFLOW_WORKSPACE", "spray-counting"),
        roboflow_workflow=os.environ.get("ROBOFLOW_WORKFLOW", "detect-count-and-visualize-2"),
        roboflow_image_input=os.environ.get("ROBOFLOW_IMAGE_INPUT", "image"),
        roboflow_stream_outputs=_csv_env("ROBOFLOW_STREAM_OUTPUTS", ["output_image"]),
        roboflow_data_outputs=_csv_env("ROBOFLOW_DATA_OUTPUTS", ["count_objects", "predictions"]),
        roboflow_processing_timeout=int(os.environ.get("ROBOFLOW_PROCESSING_TIMEOUT", "3600")),
        roboflow_requested_plan=_optional_env("ROBOFLOW_REQUESTED_PLAN", "webrtc-gpu-medium"),
        roboflow_requested_region=_optional_env("ROBOFLOW_REQUESTED_REGION", "us"),
        confidence_threshold=float(os.environ.get("CONFIDENCE_THRESHOLD", "0.85")),
        active_session_id=os.environ.get("ACTIVE_SESSION_ID", ""),
        camera_sources=camera_sources,
        entry_cameras=_csv_env("ENTRY_CAMERAS", ["CAM-01", "CAM-02"]),
        exit_cameras=_csv_env("EXIT_CAMERAS", ["CAM-03", "CAM-04"]),
        mjpeg_port=int(os.environ.get("MJPEG_PORT", "8080")),
        health_interval_seconds=int(os.environ.get("HEALTH_INTERVAL_SECONDS", "5")),
        conveyor_travel_seconds=float(os.environ.get("CONVEYOR_TRAVEL_SECONDS", "3")),
        spindle_gap_seconds=float(os.environ.get("SPINDLE_GAP_SECONDS", "5")),
        target_fps=int(os.environ.get("TARGET_FPS", "30")),
        roboflow_model_project=os.environ.get("ROBOFLOW_MODEL_PROJECT", "").strip(),
        roboflow_model_version=os.environ.get("ROBOFLOW_MODEL_VERSION", "2").strip(),
        supabase_url=os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", ""),
        supabase_service_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        mock_spindle_count=_parse_optional_int("MOCK_SPINDLE_COUNT"),
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
        source_by_camera = cast(dict[object, object], parsed)
        return {str(camera_id): str(source) for camera_id, source in source_by_camera.items()}

    mediamtx_rtsp_base_url = os.environ.get("MEDIAMTX_RTSP_BASE_URL", "").rstrip("/")
    if mediamtx_rtsp_base_url:
        return {
            "CAM-01": os.environ.get("CAM_01_SOURCE", f"{mediamtx_rtsp_base_url}/CAM-01"),
            "CAM-02": os.environ.get("CAM_02_SOURCE", f"{mediamtx_rtsp_base_url}/CAM-02"),
            "CAM-03": os.environ.get("CAM_03_SOURCE", f"{mediamtx_rtsp_base_url}/CAM-03"),
            "CAM-04": os.environ.get("CAM_04_SOURCE", f"{mediamtx_rtsp_base_url}/CAM-04"),
        }

    return {
        "CAM-01": os.environ.get("CAM_01_SOURCE", "/data/test_videos/cam01.mp4"),
        "CAM-02": os.environ.get("CAM_02_SOURCE", "/data/test_videos/cam02.mp4"),
        "CAM-03": os.environ.get("CAM_03_SOURCE", "/data/test_videos/cam03.mp4"),
        "CAM-04": os.environ.get("CAM_04_SOURCE", "/data/test_videos/cam04.mp4"),
    }


def _csv_env(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def _optional_env(name: str, default: str) -> str | None:
    value = os.environ.get(name, default).strip()
    return value or None


def _parse_optional_int(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None
