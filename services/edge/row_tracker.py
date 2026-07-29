"""Row-based rotation tracking for spindle detection."""
from __future__ import annotations

from typing import Any


class RowTracker:
    """Track unique rows on a rotating spindle by Y position in the camera frame.

    Each row appears at a consistent Y coordinate as the spindle rotates into
    view.  When a new detection's Y falls within y_tolerance pixels of a
    previously recorded row, the spindle has completed at least one full
    rotation and counting stops.

    Usage::

        tracker = RowTracker(y_tolerance=60, num_rows=3)
        while capturing:
            dets = get_detections()   # list of {x, y, width, height, ...}
            if tracker.add_frame(dets) or tracker.is_saturated():
                break
        count = tracker.total_count
    """

    def __init__(self, y_tolerance: int = 60, num_rows: int = 3) -> None:
        self.y_tolerance = y_tolerance
        self.num_rows = num_rows
        self._seen_y: list[float] = []

    def add_frame(self, detections: list[dict[str, Any]]) -> bool:
        """Process one frame of detections.

        Returns True only when a previously-seen row reappears AFTER all
        expected rows have already been recorded — confirming one full rotation.
        Repeats that occur before all rows are seen are ignored (same row still
        in front of the camera between samples).
        """
        for det in detections:
            y = float(det.get("y", 0))
            if any(abs(y - seen) <= self.y_tolerance for seen in self._seen_y):
                # This Y was seen before.  Only counts as rotation-complete
                # once every expected row has been recorded at least once.
                if len(self._seen_y) >= self.num_rows:
                    return True
                # else: same row still visible — skip, keep waiting for new rows
            elif len(self._seen_y) < self.num_rows:
                # New row — stop recording once all expected rows are seen.
                self._seen_y.append(y)
        return False

    def is_saturated(self) -> bool:
        """True once all expected rows have been seen at least once."""
        return len(self._seen_y) >= self.num_rows

    @property
    def total_count(self) -> int:
        """Unique rows recorded so far (= unique cars for 1-car-per-row spindles)."""
        return len(self._seen_y)
