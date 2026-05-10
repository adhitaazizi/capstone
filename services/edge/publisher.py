"""RabbitMQ publisher for edge detection and health events."""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import pika

logger = logging.getLogger("publisher")


class EdgePublisher:
    """Publish persistent JSON messages to RabbitMQ exchanges."""

    def __init__(self, rabbitmq_url: str) -> None:
        self.url = rabbitmq_url
        self.connection: Optional[pika.BlockingConnection] = None
        self.channel: Any = None
        self._lock = threading.Lock()

    def connect(self) -> None:
        params = pika.URLParameters(self.url)
        self.connection = pika.BlockingConnection(params)
        self.channel = self.connection.channel()
        self.channel.exchange_declare(
            exchange="detection.events", exchange_type="direct", durable=True
        )
        self.channel.exchange_declare(exchange="health", exchange_type="topic", durable=True)
        logger.info("Connected to RabbitMQ")

    def publish_entry(self, data: Dict[str, Any]) -> None:
        self._publish_detection("entry", "entry.count", data)

    def publish_exit(self, data: Dict[str, Any]) -> None:
        self._publish_detection("exit", "exit.count", data)

    def publish_camera_health(self, camera_id: str, status: str, fps: float) -> None:
        message = {
            "schema_version": "1.0",
            "event_type": "camera_health",
            "camera_code": camera_id,
            "status": status,
            "fps_actual": round(fps, 1),
            "timestamp": self._timestamp(),
        }
        self._publish("health", "camera.status", message)

    def publish_heartbeat(self, session_id: str, buffer_depth: int) -> None:
        message = {
            "schema_version": "1.0",
            "event_type": "esp32_heartbeat",
            "session_id": session_id,
            "buffer_depth": buffer_depth,
            "status": "online",
            "timestamp": self._timestamp(),
        }
        self._publish("health", "esp32.heartbeat", message)

    def close(self) -> None:
        if self.connection is not None and self.connection.is_open:
            self.connection.close()
            logger.info("RabbitMQ connection closed")

    def _publish_detection(self, checkpoint: str, routing_key: str, data: Dict[str, Any]) -> None:
        message = {
            "schema_version": "1.0",
            "event_type": "spindle_detection",
            "checkpoint": checkpoint,
            **data,
            "timestamp": self._timestamp(),
        }
        self._publish("detection.events", routing_key, message)

    def _publish(self, exchange: str, routing_key: str, message: Dict[str, Any]) -> None:
        if self.channel is None:
            raise RuntimeError("RabbitMQ publisher is not connected")

        body = json.dumps(message, separators=(",", ":"))
        with self._lock:
            self.channel.basic_publish(
                exchange=exchange,
                routing_key=routing_key,
                body=body,
                properties=pika.BasicProperties(
                    delivery_mode=2,
                    content_type="application/json",
                ),
            )
        logger.debug("Published to %s/%s: %s", exchange, routing_key, body[:160])

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat()
