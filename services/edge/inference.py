"""Roboflow hosted inference API client for edge detections."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List

import requests

logger = logging.getLogger("inference")

CONFIDENCE_THRESHOLD = 0.85


class RoboflowInference:
    """POST base64 JPEG frames to Roboflow and filter detections."""

    def __init__(
        self,
        api_key: str,
        project: str,
        version: str,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        timeout_seconds: float = 5.0,
    ) -> None:
        self.api_key = api_key
        self.endpoint = f"https://detect.roboflow.com/{project}/{version}"
        self.confidence_threshold = confidence_threshold
        self.timeout_seconds = timeout_seconds
        self.session = requests.Session()

    def detect(self, base64_frame: str, camera_id: str) -> Dict[str, Any]:
        """Run inference for one camera frame.

        Network/API failures are logged and returned as an empty detection result
        so the orchestrator can keep streaming health and later frames.
        """

        start = time.monotonic()
        if not self.api_key:
            logger.warning("Roboflow API key is not configured; returning no detections")
            return self._empty_result(start, error="missing_api_key")

        try:
            response = self.session.post(
                self.endpoint,
                data={"api_key": self.api_key, "image": base64_frame},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as exc:
            logger.warning("Roboflow request failed for %s: %s", camera_id, exc)
            return self._empty_result(start, error=str(exc))
        except ValueError as exc:
            logger.warning("Roboflow returned invalid JSON for %s: %s", camera_id, exc)
            return self._empty_result(start, error="invalid_json")

        latency_ms = int((time.monotonic() - start) * 1000)
        all_detections = payload.get("predictions", [])
        filtered = self._filter_detections(all_detections)
        confidence_avg = self._confidence_average(filtered)

        logger.info(
            "Camera %s: %s raw -> %s filtered (avg conf %.2f, %sms)",
            camera_id,
            len(all_detections),
            len(filtered),
            confidence_avg,
            latency_ms,
        )
        return {
            "detections": filtered,
            "raw_count": len(all_detections),
            "filtered_count": len(filtered),
            "confidence_avg": round(confidence_avg, 4),
            "latency_ms": latency_ms,
        }

    def _filter_detections(self, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            detection
            for detection in detections
            if float(detection.get("confidence", 0.0)) >= self.confidence_threshold
        ]

    @staticmethod
    def _confidence_average(detections: List[Dict[str, Any]]) -> float:
        if not detections:
            return 0.0
        return sum(float(detection.get("confidence", 0.0)) for detection in detections) / len(
            detections
        )

    @staticmethod
    def _empty_result(start: float, error: str) -> Dict[str, Any]:
        return {
            "detections": [],
            "raw_count": 0,
            "filtered_count": 0,
            "confidence_avg": 0.0,
            "latency_ms": int((time.monotonic() - start) * 1000),
            "error": error,
        }
