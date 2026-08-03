"""Local RT-DETR inference backend for offline edge detections."""

from __future__ import annotations

import base64
import logging
import time
from typing import Any, Dict, List

import cv2
import numpy as np
import torch
from PIL import Image

logger = logging.getLogger("local-inference")


class LocalRTDETRInference:
    """Run inference with a local RT-DETR XLarge checkpoint (.pth file)."""

    def __init__(self, model_path: str, confidence_threshold: float = 0.85) -> None:
        if not model_path:
            raise ValueError("LOCAL_MODEL_PATH is required when using local inference")
        self.model_path = model_path
        self.confidence_threshold = confidence_threshold

        try:
            from rfdetr import RFDETRBase
            logger.info("Loading RT-DETR from %s", model_path)
            self.model = RFDETRBase(
                pretrain_weights=model_path,
                encoder="dinov2_windowed_base",
                hidden_dim=512,
                patch_size=20,
                dec_layers=5,
                dec_n_points=8,
                num_windows=1,
                positional_encoding_size=35,
                resolution=700,
                num_classes=2,
            )
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            self.model.optimize_for_inference()
            logger.info("RT-DETR model loaded on device: %s", self.device.upper())
        except ImportError:
            raise RuntimeError("rfdetr package not found. Install with: pip install rfdetr")
        except Exception as exc:
            raise RuntimeError(f"Failed to load RT-DETR model from {model_path}: {exc}")

    def detect(self, base64_frame: str, camera_id: str) -> Dict[str, Any]:
        start = time.monotonic()

        try:
            frame_bytes = base64.b64decode(base64_frame)
            frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                return self._empty_result(start, "invalid_frame")

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_image = Image.fromarray(rgb)
            detections = self.model.predict(pil_image, threshold=self.confidence_threshold)
        except Exception as exc:
            logger.warning("Local inference failed for %s: %s", camera_id, exc)
            return self._empty_result(start, str(exc))

        latency_ms = int((time.monotonic() - start) * 1000)
        detections_list: List[Dict[str, Any]] = []
        raw_count = 0

        try:
            if detections is not None and hasattr(detections, "xyxy"):
                boxes = detections.xyxy
                scores = detections.confidence if hasattr(detections, "confidence") else []
                class_ids = detections.class_id if hasattr(detections, "class_id") else []
                raw_count = len(boxes)

                for i, box in enumerate(boxes):
                    conf = float(scores[i]) if i < len(scores) else 0.0
                    if conf < self.confidence_threshold:
                        continue
                    x1, y1, x2, y2 = box[:4]
                    cls_id = int(class_ids[i]) if i < len(class_ids) else 0
                    detections_list.append(
                        {
                            "x": float((x1 + x2) / 2),
                            "y": float((y1 + y2) / 2),
                            "width": float(max(0.0, x2 - x1)),
                            "height": float(max(0.0, y2 - y1)),
                            "confidence": conf,
                            "class": cls_id,
                        }
                    )
        except Exception as exc:
            logger.warning("Failed to parse RT-DETR detections for %s: %s", camera_id, exc)

        confidence_avg = self._confidence_average(detections_list)
        logger.info(
            "Camera %s RT-DETR: %s raw -> %s filtered (avg conf %.2f, %sms)",
            camera_id,
            raw_count,
            len(detections_list),
            confidence_avg,
            latency_ms,
        )
        return {
            "detections": detections_list,
            "raw_count": raw_count,
            "filtered_count": len(detections_list),
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


# Backward compatibility alias
LocalYOLOInference = LocalRTDETRInference