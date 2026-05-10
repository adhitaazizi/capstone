from typing import Any

from persistence import SupabasePersistence


class HealthMessageHandler:
    def __init__(self, persistence: SupabasePersistence) -> None:
        self.persistence = persistence

    def handle(self, message: dict[str, Any]) -> None:
        self.persistence.update_camera_status(message)
