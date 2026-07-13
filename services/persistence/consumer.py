import json
import logging
from typing import Any

import pika

from health_consumer import HealthMessageHandler
from persistence import SupabasePersistence

LOGGER = logging.getLogger(__name__)


class PersistenceConsumer:
    QUEUES = ("spindle.entry", "spindle.exit", "health.camera")

    def __init__(self, rabbitmq_url: str, persistence: SupabasePersistence) -> None:
        self.rabbitmq_url = rabbitmq_url
        self.persistence = persistence
        self.health_handler = HealthMessageHandler(persistence)
        self.connection: pika.SelectConnection | None = None
        self.channel: pika.channel.Channel | None = None
        self.closing = False
        self.should_reconnect = False

    def run(self) -> bool:
        self.should_reconnect = False
        self.connection = self._connect()
        self.connection.ioloop.start()
        return self.should_reconnect

    def close(self) -> None:
        self.closing = True
        if self.channel and self.channel.is_open:
            self.channel.close()
        if self.connection and self.connection.is_open:
            self.connection.close()

    def _connect(self) -> pika.SelectConnection:
        LOGGER.info("Connecting to RabbitMQ")
        parameters = pika.URLParameters(self.rabbitmq_url)
        return pika.SelectConnection(
            parameters=parameters,
            on_open_callback=self._on_connection_open,
            on_open_error_callback=self._on_connection_open_error,
            on_close_callback=self._on_connection_closed,
        )

    def _on_connection_open(self, connection: pika.SelectConnection) -> None:
        LOGGER.info("RabbitMQ connection opened")
        connection.channel(on_open_callback=self._on_channel_open)

    def _on_connection_open_error(
        self, connection: pika.SelectConnection, error: Exception
    ) -> None:
        LOGGER.error("RabbitMQ connection open failed: %s", error)
        self.should_reconnect = True
        connection.ioloop.stop()

    def _on_connection_closed(
        self, connection: pika.SelectConnection, reason: Exception
    ) -> None:
        self.channel = None
        if self.closing:
            connection.ioloop.stop()
            return

        LOGGER.warning("RabbitMQ connection closed: %s", reason)
        self.should_reconnect = True
        connection.ioloop.stop()

    def _on_channel_open(self, channel: pika.channel.Channel) -> None:
        LOGGER.info("RabbitMQ channel opened")
        self.channel = channel
        channel.add_on_close_callback(self._on_channel_closed)
        channel.basic_qos(prefetch_count=1, callback=self._on_qos_ok)

    def _on_channel_closed(self, channel: pika.channel.Channel, reason: Exception) -> None:
        LOGGER.warning("RabbitMQ channel closed: %s", reason)
        self.channel = None
        if not self.closing and self.connection and self.connection.is_open:
            self.connection.close()

    def _on_qos_ok(self, _frame: Any) -> None:
        LOGGER.info("QoS set to prefetch_count=1")
        self._declare_queue(0)

    def _declare_queue(self, index: int) -> None:
        if not self.channel:
            return
        if index >= len(self.QUEUES):
            self._start_consuming()
            return

        queue_name = self.QUEUES[index]
        self.channel.queue_declare(
            queue=queue_name,
            passive=True,
            callback=lambda _frame, next_index=index + 1: self._declare_queue(next_index),
        )

    def _start_consuming(self) -> None:
        if not self.channel:
            return

        for queue_name in self.QUEUES:
            self.channel.basic_consume(
                queue=queue_name,
                on_message_callback=self._on_message,
                auto_ack=False,
            )
            LOGGER.info("Consuming queue=%s", queue_name)

    def _on_message(
        self,
        channel: pika.channel.Channel,
        method: pika.spec.Basic.Deliver,
        properties: pika.BasicProperties,
        body: bytes,
    ) -> None:
        del properties
        try:
            message = json.loads(body.decode("utf-8"))
            self._handle_message(method.routing_key, message)
        except Exception:
            LOGGER.exception("Message failed queue=%s", method.routing_key)
            channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            return

        channel.basic_ack(delivery_tag=method.delivery_tag)

    def _handle_message(self, routing_key: str, message: dict[str, Any]) -> None:
        if routing_key == "entry.count":
            self.persistence.insert_spindle_entry(message)
            return
        if routing_key == "exit.count":
            self.persistence.update_spindle_exit(message)
            return
        if routing_key in ("camera.status", "health.camera"):
            self.health_handler.handle(message)
            return

        raise ValueError(f"unsupported routing_key: {routing_key}")
