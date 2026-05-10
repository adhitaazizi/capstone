import logging
import os
from typing import Any

from supabase import create_client
from supabase.lib.client_options import ClientOptions

LOGGER = logging.getLogger(__name__)


class PersistenceError(RuntimeError):
    """Raised when a message cannot be persisted safely."""


class SupabasePersistence:
    def __init__(self, url: str | None = None, service_key: str | None = None) -> None:
        supabase_url = url or os.environ.get("SUPABASE_URL")
        supabase_key = service_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

        if not supabase_url:
            raise PersistenceError("SUPABASE_URL is required")
        if not supabase_key:
            raise PersistenceError("SUPABASE_SERVICE_ROLE_KEY is required")

        self.supabase = create_client(
            supabase_url,
            supabase_key,
            options=ClientOptions(auto_refresh_token=False, persist_session=False),
        )
        self._active_model_id: int | None = None
        self._camera_id_by_code: dict[str, int] = {}

    def insert_spindle_entry(self, message: dict[str, Any]) -> None:
        spindle_pass_id = _required(message, "spindle_pass_id")
        session_id = _required(message, "session_id")
        count = int(_required(message, "deduplicated_count"))
        timestamp = _required(message, "timestamp")

        self.supabase.table("spindle_pass").insert(
            {
                "spindle_pass_id": spindle_pass_id,
                "session_id": session_id,
                "entry_count": count,
                "entry_time": timestamp,
                "status": "in_progress",
            }
        ).execute()

        self._insert_detection_events(message, spindle_pass_id, timestamp)
        LOGGER.info("Persisted entry spindle_pass_id=%s count=%s", spindle_pass_id, count)

    def update_spindle_exit(self, message: dict[str, Any]) -> None:
        spindle_pass_id = _required(message, "spindle_pass_id")
        exit_count = int(_required(message, "deduplicated_count"))
        timestamp = _required(message, "timestamp")

        existing = (
            self.supabase.table("spindle_pass")
            .select("entry_count")
            .eq("spindle_pass_id", spindle_pass_id)
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise PersistenceError(f"spindle_pass not found: {spindle_pass_id}")

        entry_count = int(existing.data[0]["entry_count"])
        mismatch_delta = exit_count - entry_count
        status = "matched" if mismatch_delta == 0 else "mismatched"

        self.supabase.table("spindle_pass").update(
            {
                "exit_count": exit_count,
                "exit_time": timestamp,
                "status": status,
                "mismatch_delta": mismatch_delta,
            }
        ).eq("spindle_pass_id", spindle_pass_id).execute()

        self._insert_detection_events(message, spindle_pass_id, timestamp)
        LOGGER.info(
            "Persisted exit spindle_pass_id=%s count=%s status=%s delta=%s",
            spindle_pass_id,
            exit_count,
            status,
            mismatch_delta,
        )

    def update_camera_status(self, message: dict[str, Any]) -> None:
        camera_code = _required(message, "camera_code")
        status = _required(message, "status")
        db_status = _map_camera_status(str(status))

        response = (
            self.supabase.table("camera")
            .update({"status": db_status})
            .eq("camera_code", camera_code)
            .execute()
        )
        if not response.data:
            raise PersistenceError(f"camera not found: {camera_code}")

        LOGGER.info("Updated camera_code=%s status=%s", camera_code, db_status)

    def _insert_detection_events(
        self, message: dict[str, Any], spindle_pass_id: str, timestamp: str
    ) -> None:
        raw_counts = message.get("raw_counts") or {}
        if not isinstance(raw_counts, dict):
            raise PersistenceError("raw_counts must be an object")

        camera_codes = message.get("camera_ids") or list(raw_counts.keys())
        if not isinstance(camera_codes, list):
            raise PersistenceError("camera_ids must be a list")

        model_id = self._get_active_model_id()
        events = []
        for camera_code in camera_codes:
            if camera_code not in raw_counts:
                continue

            events.append(
                {
                    "camera_id": self._get_camera_id(str(camera_code)),
                    "model_id": model_id,
                    "spindle_pass_id": spindle_pass_id,
                    "frame_timestamp": timestamp,
                    "raw_count": int(raw_counts[camera_code]),
                    "confidence_avg": message.get("confidence_avg"),
                    "processing_time_ms": message.get("inference_latency_ms"),
                }
            )

        if events:
            self.supabase.table("detection_event").insert(events).execute()

    def _get_active_model_id(self) -> int:
        if self._active_model_id is not None:
            return self._active_model_id

        response = (
            self.supabase.table("detection_model")
            .select("model_id")
            .eq("is_active", True)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise PersistenceError("active detection_model not found")

        self._active_model_id = int(response.data[0]["model_id"])
        return self._active_model_id

    def _get_camera_id(self, camera_code: str) -> int:
        if camera_code in self._camera_id_by_code:
            return self._camera_id_by_code[camera_code]

        response = (
            self.supabase.table("camera")
            .select("camera_id")
            .eq("camera_code", camera_code)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise PersistenceError(f"camera not found: {camera_code}")

        camera_id = int(response.data[0]["camera_id"])
        self._camera_id_by_code[camera_code] = camera_id
        return camera_id


def _required(message: dict[str, Any], key: str) -> Any:
    value = message.get(key)
    if value is None:
        raise PersistenceError(f"missing required field: {key}")
    return value


def _map_camera_status(status: str) -> str:
    status_map = {
        "online": "active",
        "offline": "inactive",
        "error": "error",
    }
    try:
        return status_map[status.lower()]
    except KeyError as exc:
        raise PersistenceError(f"unsupported camera status: {status}") from exc
