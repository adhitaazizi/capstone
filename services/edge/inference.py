"""Roboflow WebRTC workflow manager for edge detections."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, TypeVar

import numpy as np
from inference_sdk import InferenceHTTPClient
from inference_sdk.webrtc import ManualSource, StreamConfig, VideoMetadata
from numpy.typing import NDArray

logger = logging.getLogger("inference")
_DataHandler = TypeVar("_DataHandler", bound=Callable[[dict[str, object], VideoMetadata | None], None])


class WebRTCSession(Protocol):
    def on_data(self) -> Callable[[_DataHandler], _DataHandler]: ...

    def run(self) -> None: ...

    def close(self) -> None: ...


@dataclass
class CameraWorkflowState:
    latest_result: dict[str, object]
    updated_at: float = 0.0


@dataclass
class CameraWorkflowSession:
    session: WebRTCSession
    source: ManualSource
    thread: threading.Thread


@dataclass
class RoboflowInference:
    """Run one Roboflow WebRTC workflow session per camera source."""

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
    timeout_seconds: float = 5.0
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _states: dict[str, CameraWorkflowState] = field(default_factory=dict, init=False)
    _sessions: dict[str, CameraWorkflowSession] = field(default_factory=dict, init=False)
    _errors: dict[str, str] = field(default_factory=dict, init=False)

    def start(self) -> None:
        if not self.api_key:
            logger.warning("Roboflow API key is not configured; workflow sessions not started")
            return

        client = InferenceHTTPClient.init(api_url=self.api_url, api_key=self.api_key)
        config = StreamConfig(
            stream_output=self.stream_output,
            data_output=self.data_output,
            processing_timeout=self.processing_timeout,
            requested_plan=self.requested_plan,
            requested_region=self.requested_region,
        )

        for camera_id in self.camera_sources:
            source = ManualSource()
            session = client.webrtc.stream(
                source=source,
                workflow=self.workflow,
                workspace=self.workspace,
                image_input=self.image_input,
                config=config,
            )
            self._register_handlers(camera_id, session)
            thread = threading.Thread(
                target=self._run_session,
                args=(camera_id, session),
                daemon=True,
            )
            self._sessions[camera_id] = CameraWorkflowSession(
                session=session,
                source=source,
                thread=thread,
            )
            thread.start()
            logger.info(
                "Started Roboflow manual workflow session camera=%s source=%s workflow=%s/%s",
                camera_id,
                self.camera_sources[camera_id],
                self.workspace,
                self.workflow,
            )

    def stop(self) -> None:
        for workflow_session in self._sessions.values():
            workflow_session.session.close()
        for workflow_session in self._sessions.values():
            workflow_session.thread.join(timeout=2.0)
        self._sessions.clear()

    def detect(self, camera_id: str, frame: NDArray[np.uint8] | None = None) -> dict[str, object]:
        start = time.monotonic()
        if frame is not None:
            sent = self._send_frame(camera_id, frame, start)
            if not sent:
                return _empty_result(start, error="webrtc_session_not_ready")
            result = self._wait_for_result(camera_id, start)
            if result is not None:
                return result

        with self._lock:
            state = self._states.get(camera_id)
            if state is not None:
                result = dict(state.latest_result)
                result["latency_ms"] = int((time.monotonic() - state.updated_at) * 1000)
                return result
            error = self._errors.get(camera_id)
            if error is not None:
                return _empty_result(start, error=error)

        return _empty_result(start, error="waiting_for_webrtc_result")

    def _send_frame(self, camera_id: str, frame: NDArray[np.uint8], start: float) -> bool:
        while time.monotonic() - start < self.timeout_seconds:
            with self._lock:
                workflow_session = self._sessions.get(camera_id)
                error = self._errors.get(camera_id)
            if error is not None:
                return False
            if workflow_session is None:
                return False
            try:
                workflow_session.source.send(frame)
                return True
            except RuntimeError:
                time.sleep(0.05)
        return False

    def _wait_for_result(self, camera_id: str, start: float) -> dict[str, object] | None:
        while time.monotonic() - start < self.timeout_seconds:
            with self._lock:
                state = self._states.get(camera_id)
                error = self._errors.get(camera_id)
            if error is not None:
                return _empty_result(start, error=error)
            if state is not None and state.updated_at >= start:
                result = dict(state.latest_result)
                result["latency_ms"] = int((state.updated_at - start) * 1000)
                return result
            time.sleep(0.02)
        return None

    def _register_handlers(self, camera_id: str, session: WebRTCSession) -> None:
        @session.on_data()
        def on_data(data: dict[str, object], metadata: VideoMetadata | None) -> None:
            result = _result_from_workflow_data(data, self.confidence_threshold)
            with self._lock:
                self._states[camera_id] = CameraWorkflowState(
                    latest_result=result,
                    updated_at=time.monotonic(),
                )
            logger.info(
                "Camera %s workflow frame=%s raw=%s filtered=%s",
                camera_id,
                metadata.frame_id if metadata else None,
                result["raw_count"],
                result["filtered_count"],
            )

    def _run_session(self, camera_id: str, session: WebRTCSession) -> None:
        try:
            session.run()
        except Exception as exc:
            logger.warning("Roboflow workflow session failed for %s: %s", camera_id, exc)
            with self._lock:
                self._errors[camera_id] = str(exc)
        finally:
            session.close()


def _result_from_workflow_data(
    data: Mapping[str, object],
    confidence_threshold: float,
) -> dict[str, object]:
    predictions = _extract_predictions(data.get("predictions"))
    filtered = [
        detection
        for detection in (_normalize_prediction(prediction) for prediction in predictions)
        if detection is not None and _as_float(detection["confidence"]) >= confidence_threshold
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
    return sum(_as_float(detection.get("confidence", 0.0)) for detection in detections) / len(detections)


def _empty_result(start: float, error: str) -> dict[str, object]:
    return {
        "detections": [],
        "raw_count": 0,
        "filtered_count": 0,
        "confidence_avg": 0.0,
        "latency_ms": int((time.monotonic() - start) * 1000),
        "error": error,
    }
