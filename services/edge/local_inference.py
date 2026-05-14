"""Local YOLO inference backend for offline edge detections."""

from __future__ import annotations

import base64
import logging
import time
from typing import Any, Dict, List

import cv2
import numpy as np
from ultralytics import YOLO

logger = logging.getLogger("local-inference")


class LocalYOLOInference:
    """Run inference with a local YOLO model file (for example best.pt)."""

    def __init__(self, model_path: str, confidence_threshold: float = 0.85) -> None:
        if not model_path:
            raise ValueError("LOCAL_MODEL_PATH is required when using local inference")
        self.model_path = model_path
        self.confidence_threshold = confidence_threshold
        self.model = YOLO(model_path)
        logger.info("Loaded local model from %s", model_path)

    def detect(self, base64_frame: str, camera_id: str) -> Dict[str, Any]:
        start = time.monotonic()

        try:
            frame_bytes = base64.b64decode(base64_frame)
            frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                return self._empty_result(start, "invalid_frame")

            result = self.model.predict(
                source=frame,
                conf=self.confidence_threshold,
                verbose=False,
                device="cpu",
            )[0]
        except Exception as exc:
            logger.warning("Local inference failed for %s: %s", camera_id, exc)
            return self._empty_result(start, str(exc))

        latency_ms = int((time.monotonic() - start) * 1000)
        raw_count = len(result.boxes)

        detections: List[Dict[str, Any]] = []
        for box in result.boxes:
            conf = float(box.conf.item())
            if conf < self.confidence_threshold:
                continue

            x1, y1, x2, y2 = box.xyxy[0].tolist()
            detections.append(
                {
                    "x": (x1 + x2) / 2,
                    "y": (y1 + y2) / 2,
                    "width": max(0.0, x2 - x1),
                    "height": max(0.0, y2 - y1),
                    "confidence": conf,
                    "class": int(box.cls.item()) if box.cls is not None else None,
                }
            )

        confidence_avg = self._confidence_average(detections)
        logger.info(
            "Camera %s local model: %s raw -> %s filtered (avg conf %.2f, %sms)",
            camera_id,
            raw_count,
            len(detections),
            confidence_avg,
            latency_ms,
        )
        return {
            "detections": detections,
            "raw_count": raw_count,
            "filtered_count": len(detections),
            "confidence_avg": round(confidence_avg, 4),
            "latency_ms": latency_ms,
        }

    @staticmethod
    def _confidence_average(detections: List[Dict[str, Any]]) -> float:
        if not detections:
            return 0.0
        return sum(float(item.get("confidence", 0.0)) for item in detections) / len(detections)

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