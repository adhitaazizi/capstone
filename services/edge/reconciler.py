"""FIFO ring buffer for matching entry and exit spindle detections."""

from __future__ import annotations

import logging
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, Optional

logger = logging.getLogger("reconciler")

MAX_BUFFER_SIZE = 50
ORPHAN_TIMEOUT_SECONDS = 300


class FIFOReconciler:
    """Track entry events and reconcile them with exit events in FIFO order."""

    def __init__(self, max_size: int = MAX_BUFFER_SIZE) -> None:
        self.buffer: Deque[Dict[str, Any]] = deque(maxlen=max_size)

    def push_entry(self, session_id: str, count: int) -> str:
        """Push an entry event and return its generated spindle_pass_id."""

        self._purge_orphans()
        if len(self.buffer) == self.buffer.maxlen:
            logger.warning("FIFO buffer full; oldest entry will be dropped")

        spindle_pass_id = str(uuid.uuid4())
        self.buffer.append(
            {
                "spindle_pass_id": spindle_pass_id,
                "session_id": session_id,
                "entry_count": count,
                "entry_time": datetime.now(timezone.utc).isoformat(),
            }
        )
        logger.info("ENTRY: %s count=%s buffer_depth=%s", spindle_pass_id, count, len(self.buffer))
        return spindle_pass_id

    def pop_exit(self, exit_count: int) -> Optional[Dict[str, Any]]:
        """Pop the oldest entry and reconcile it with an exit count."""

        self._purge_orphans()
        if not self.buffer:
            logger.warning("EXIT event with empty FIFO buffer")
            return None

        entry = self.buffer.popleft()
        entry_count = int(entry["entry_count"])
        delta = abs(entry_count - exit_count)
        status = "matched" if delta == 0 else "mismatched"
        result = {
            "spindle_pass_id": entry["spindle_pass_id"],
            "session_id": entry["session_id"],
            "entry_count": entry_count,
            "exit_count": exit_count,
            "status": status,
            "mismatch_delta": delta,
        }
        logger.info(
            "EXIT: %s entry=%s exit=%s -> %s delta=%s buffer_depth=%s",
            entry["spindle_pass_id"],
            entry_count,
            exit_count,
            status,
            delta,
            len(self.buffer),
        )
        return result

    @property
    def depth(self) -> int:
        return len(self.buffer)

    def _purge_orphans(self) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ORPHAN_TIMEOUT_SECONDS)
        while self.buffer:
            entry_time = datetime.fromisoformat(self.buffer[0]["entry_time"])
            if entry_time >= cutoff:
                break
            orphan = self.buffer.popleft()
            logger.warning(
                "ORPHAN: %s timed out after %ss",
                orphan["spindle_pass_id"],
                ORPHAN_TIMEOUT_SECONDS,
            )
