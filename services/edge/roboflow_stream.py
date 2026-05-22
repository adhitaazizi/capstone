"""Roboflow WebRTC workflow bridge for RTSP/MJPEG sources.

This optional process is for the workflow-based Roboflow stream API. It keeps
the existing counting pipeline untouched and exposes Roboflow's annotated video
output as a local MJPEG endpoint for dashboard experiments.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from importlib import import_module
from typing import cast

import cv2
import numpy as np
from dotenv import load_dotenv
from inference_sdk import InferenceHTTPClient
from inference_sdk.webrtc import (
    LocalStreamSource,
    MJPEGSource,
    RTSPSource,
    StreamConfig,
    VideoMetadata,
)

MJPEGServer = cast(type, import_module("mjpeg_server").MJPEGServer)

_ = load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("roboflow-stream")


@dataclass
class LatestFrameSource:
    """Adapter consumed by MJPEGServer."""

    last_frame: bytes | None = None
    actual_fps: float = 0.0


class FPSCounter:
    def __init__(self) -> None:
        self.frames_seen: int = 0
        self.started_at: float = time.monotonic()

    def record(self) -> float:
        self.frames_seen += 1
        elapsed = time.monotonic() - self.started_at
        if elapsed < 1.0:
            return 0.0

        fps = self.frames_seen / elapsed
        self.frames_seen = 0
        self.started_at = time.monotonic()
        return fps


def main() -> None:
    api_key = os.environ.get("ROBOFLOW_API_KEY", "")
    workspace = _required_env("ROBOFLOW_WORKSPACE")
    workflow = os.environ.get("ROBOFLOW_WORKFLOW", "detect-count-and-visualize-2")
    source_url = _required_env("ROBOFLOW_STREAM_SOURCE_URL")
    source_mode = os.environ.get("ROBOFLOW_STREAM_SOURCE_MODE", "local").strip().lower()
    camera_id = os.environ.get("ROBOFLOW_STREAM_CAMERA_ID", "CAM-01")

    frame_source = LatestFrameSource()
    mjpeg_server = MJPEGServer(port=int(os.environ.get("ROBOFLOW_MJPEG_PORT", "8081")))
    mjpeg_server.start({camera_id: frame_source})

    client = InferenceHTTPClient.init(
        api_url=os.environ.get("ROBOFLOW_API_URL", "https://serverless.roboflow.com"),
        api_key=api_key,
    )

    config = StreamConfig(
        stream_output=_csv_env("ROBOFLOW_STREAM_OUTPUTS", ["output_image"]),
        data_output=_csv_env("ROBOFLOW_DATA_OUTPUTS", ["count_objects", "predictions"]),
        processing_timeout=int(os.environ.get("ROBOFLOW_PROCESSING_TIMEOUT", "3600")),
        requested_plan=os.environ.get("ROBOFLOW_REQUESTED_PLAN", "webrtc-gpu-medium"),
        requested_region=os.environ.get("ROBOFLOW_REQUESTED_REGION", "us"),
    )

    session = client.webrtc.stream(
        source=_build_source(source_url, source_mode),
        workflow=workflow,
        workspace=workspace,
        image_input=os.environ.get("ROBOFLOW_IMAGE_INPUT", "image"),
        config=config,
    )

    fps_counter = FPSCounter()

    @session.on_frame
    def on_frame(frame: object, _metadata: VideoMetadata) -> None:
        if not isinstance(frame, np.ndarray):
            logger.warning("Roboflow output frame has unsupported type: %s", type(frame).__name__)
            return

        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            logger.warning("Failed to encode Roboflow output frame")
            return

        frame_source.last_frame = jpeg.tobytes()
        measured_fps = fps_counter.record()
        if measured_fps:
            frame_source.actual_fps = measured_fps

    @session.on_data()
    def on_data(data: dict[str, object], metadata: VideoMetadata | None) -> None:
        logger.info(
            "Roboflow frame=%s outputs=%s",
            metadata.frame_id if metadata else None,
            sorted(data.keys()),
        )

    try:
        logger.info(
            "Starting Roboflow stream camera=%s mode=%s source=%s workflow=%s/%s",
            camera_id,
            source_mode,
            source_url,
            workspace,
            workflow,
        )
        session.run()
    finally:
        session.close()
        threading.Thread(target=mjpeg_server.stop, daemon=True).start()


def _build_source(source_url: str, source_mode: str) -> LocalStreamSource | RTSPSource | MJPEGSource:
    if source_mode == "rtsp":
        return RTSPSource(source_url)
    if source_mode == "mjpeg":
        return MJPEGSource(source_url)
    if source_mode == "local":
        return LocalStreamSource(source_url)
    raise ValueError("ROBOFLOW_STREAM_SOURCE_MODE must be local, rtsp, or mjpeg")


def _csv_env(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    main()
