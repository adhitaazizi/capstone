"""HTTP-based Roboflow workflow inference for edge detections."""

from __future__ import annotations

import base64
import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
import requests
from numpy.typing import NDArray

logger = logging.getLogger("inference")


_LOCAL_URL_HINTS = ("localhost", "127.0.0.1", "host.docker.internal")


@dataclass
class RoboflowInference:
    """Run Roboflow inference via HTTP POST for each camera frame.

    Uses the local Roboflow inference server (client.infer) when api_url points
    to a local host, and the cloud workflow API (client.run_workflow) otherwise.
    """

    api_key: str
    api_url: str
    workspace: str
    workflow: str
    image_input: str
    camera_sources: Mapping[str, str]
    confidence_threshold: float
    stream_output: list[str]
    data_output: list[str]
    processing_timeout: int
    requested_plan: str | None
    requested_region: str | None
    model_project: str = ""
    model_version: str = "2"
    timeout_seconds: float = 15.0
    mock_count: int | None = None
    _client: Any = field(default=None, init=False, repr=False)
    _is_local: bool = field(default=False, init=False, repr=False)

    def start(self) -> None:
        if self.mock_count is not None:
            logger.info("Mock inference mode active — returning %s per camera", self.mock_count)
            return
        if not self.api_key:
            logger.warning("Roboflow API key is not configured; inference will return empty results")
            return
        self._is_local = any(hint in self.api_url for hint in _LOCAL_URL_HINTS)
        try:
            from inference_sdk import InferenceHTTPClient
            self._client = InferenceHTTPClient.init(
                api_url=self.api_url,
                api_key=self.api_key,
            )
            if self._is_local:
                logger.info(
                    "Roboflow local inference ready — model=%s/%s api_url=%s",
                    self.model_project, self.model_version, self.api_url,
                )
            else:
                logger.info(
                    "Roboflow cloud workflow ready — workspace=%s workflow=%s",
                    self.workspace, self.workflow,
                )
        except Exception as exc:
            logger.warning("Failed to initialize Roboflow HTTP client: %s", exc)

    def stop(self) -> None:
        self._client = None

    def detect(self, camera_id: str, frame: NDArray[np.uint8] | None = None) -> dict[str, object]:
        start = time.monotonic()
        if self.mock_count is not None:
            n = self.mock_count
            detections = [
                {"x": 80.0 + i * 80.0, "y": 320.0, "width": 50.0, "height": 50.0,
                 "confidence": 0.92, "class": "Car"}
                for i in range(n)
            ]
            return {
                "detections": detections,
                "raw_count": n,
                "filtered_count": n,
                "confidence_avg": 0.92,
                "latency_ms": 0,
            }
        if self._client is None or frame is None:
            return _empty_result(start, error="client_not_ready")

        try:
            if self._is_local:
                output = self._infer_local(frame)
            else:
                raw = self._client.run_workflow(
                    workspace_name=self.workspace,
                    workflow_id=self.workflow,
                    images={self.image_input: frame},
                )
                output = raw[0] if raw else {}

            result = _result_from_workflow_data(output, self.confidence_threshold)
            result["latency_ms"] = int((time.monotonic() - start) * 1000)
            logger.info(
                "Camera %s raw=%s filtered=%s latency=%sms",
                camera_id,
                result["raw_count"],
                result["filtered_count"],
                result["latency_ms"],
            )
            return result
        except Exception as exc:
            logger.warning("Roboflow inference failed for %s: %s", camera_id, exc)
            return _empty_result(start, error=str(exc))


    def _infer_local(self, frame: NDArray[np.uint8]) -> dict[str, object]:
        """POST to the local inference server using the same format as /api/detect."""
        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        b64 = base64.b64encode(jpeg.tobytes()).decode("utf-8")
        model_id = f"{self.model_project}/{self.model_version}"
        resp = requests.post(
            f"{self.api_url}/infer/object_detection",
            json={
                "api_key": self.api_key,
                "model_id": model_id,
                "image": {"type": "base64", "value": b64},
            },
            timeout=self.timeout_seconds,
        )
        resp.raise_for_status()
        return resp.json()


def _result_from_workflow_data(
    data: Mapping[str, object],
    confidence_threshold: float,
) -> dict[str, object]:
    predictions = _extract_predictions(data.get("predictions"))
    filtered = [
        det
        for det in (_normalize_prediction(p) for p in predictions)
        if det is not None and _as_float(det["confidence"]) >= confidence_threshold
    ]
    raw_count = _extract_count(data.get("count_objects"), len(predictions))
    confidence_avg = _confidence_average(filtered)
    return {
        "detections": filtered,
        "raw_count": raw_count,
        "filtered_count": len(filtered),
        "confidence_avg": round(confidence_avg, 4),
        "latency_ms": 0,
    }


def _extract_predictions(value: object) -> list[Mapping[str, object]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, Mapping)]
    if isinstance(value, Mapping):
        nested = value.get("predictions")
        if isinstance(nested, list):
            return [item for item in nested if isinstance(item, Mapping)]
    return []


def _normalize_prediction(prediction: Mapping[str, object]) -> dict[str, object] | None:
    try:
        confidence = _as_float(prediction.get("confidence", 0.0))
        if {"x", "y", "width", "height"}.issubset(prediction):
            return {
                "x": _as_float(prediction["x"]),
                "y": _as_float(prediction["y"]),
                "width": _as_float(prediction["width"]),
                "height": _as_float(prediction["height"]),
                "confidence": confidence,
                "class": prediction.get("class"),
            }
        if {"x_min", "y_min", "x_max", "y_max"}.issubset(prediction):
            x_min = _as_float(prediction["x_min"])
            y_min = _as_float(prediction["y_min"])
            x_max = _as_float(prediction["x_max"])
            y_max = _as_float(prediction["y_max"])
            return {
                "x": (x_min + x_max) / 2,
                "y": (y_min + y_max) / 2,
                "width": max(0.0, x_max - x_min),
                "height": max(0.0, y_max - y_min),
                "confidence": confidence,
                "class": prediction.get("class"),
            }
    except (TypeError, ValueError):
        return None
    return None


def _as_float(value: object) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not numeric")
    if isinstance(value, (int, float, str)):
        return float(value)
    raise ValueError("value is not numeric")


def _extract_count(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Mapping):
        for key in ("count", "total", "value"):
            nested = value.get(key)
            if isinstance(nested, (int, float)) and not isinstance(nested, bool):
                return int(nested)
    return default


def _confidence_average(detections: Sequence[Mapping[str, object]]) -> float:
    if not detections:
        return 0.0
    return sum(_as_float(d.get("confidence", 0.0)) for d in detections) / len(detections)


def _empty_result(start: float, error: str) -> dict[str, object]:
    return {
        "detections": [],
        "raw_count": 0,
        "filtered_count": 0,
        "confidence_avg": 0.0,
        "latency_ms": int((time.monotonic() - start) * 1000),
        "error": error,
    }
