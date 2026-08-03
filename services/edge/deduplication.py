"""Cross-camera deduplication using homography projection."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Sequence

import numpy as np

DEDUP_RADIUS_MM = 30.0
_DEFAULT_JSON = Path(__file__).parent / "homography_matrices.json"

logger = logging.getLogger("deduplication")


def _load_homographies(json_path: Path | str | None) -> Dict[str, np.ndarray]:
    """Load homography matrices from JSON, returning empty dict on any failure."""
    if json_path is None:
        return {}
    path = Path(json_path)
    if not path.exists():
        logger.info("homography_matrices.json not found at %s — using identity fallback", path)
        return {}
    try:
        data = json.loads(path.read_text())
        matrices = {cam_id: np.array(mat, dtype=np.float64) for cam_id, mat in data.items()}
        logger.info("Loaded homographies for cameras: %s", list(matrices.keys()))
        return matrices
    except Exception as exc:
        logger.warning("Failed to load homographies from %s: %s — using identity fallback", path, exc)
        return {}


class CrossCameraDeduplicator:
    """Merge detections whose projected bbox centers are within 30mm.

    When no real calibration is available (all matrices are identity or the
    dict is empty), falls back to max(count_per_camera) to avoid double-counting
    overlapping cameras without needing physical ArUco calibration.
    """

    def __init__(
        self,
        homographies: Mapping[str, np.ndarray] | None = None,
        json_path: Path | str | None = _DEFAULT_JSON,
    ) -> None:
        if homographies is not None:
            self.homographies = dict(homographies)
        else:
            self.homographies = _load_homographies(json_path)

    @classmethod
    def identity_for(cls, camera_ids: Iterable[str]) -> "CrossCameraDeduplicator":
        """Create demo-mode identity homographies for each camera."""
        return cls({camera_id: np.eye(3, dtype=np.float64) for camera_id in camera_ids})

    def has_real_calibration(self) -> bool:
        """True if at least one camera has a non-identity homography matrix."""
        return any(
            not np.allclose(h, np.eye(3))
            for h in self.homographies.values()
        )

    def project_to_ground(
        self, detections: Sequence[Dict[str, float]], homography: np.ndarray
    ) -> np.ndarray:
        """Project detection centers through a 3x3 homography matrix."""
        if not detections:
            return np.empty((0, 2), dtype=np.float64)

        centers = np.array(
            [[float(detection["x"]), float(detection["y"])] for detection in detections],
            dtype=np.float64,
        )
        homogeneous = np.hstack([centers, np.ones((centers.shape[0], 1))])
        projected = (homography @ homogeneous.T).T
        return projected[:, :2] / projected[:, 2:3]

    def deduplicate_pair(
        self,
        cam1_id: str,
        cam1_detections: Sequence[Dict[str, float]],
        cam2_id: str,
        cam2_detections: Sequence[Dict[str, float]],
    ) -> int:
        """Deduplicate two camera detection lists."""
        return self.deduplicate_many(
            {cam1_id: list(cam1_detections), cam2_id: list(cam2_detections)}
        )

    def deduplicate_many(self, detections_by_camera: Mapping[str, Sequence[Dict[str, float]]]) -> int:
        """Deduplicate detections from any number of cameras.

        Without real homography calibration (identity matrices or empty dict),
        takes max(count_per_camera) to safely avoid double-counting overlapping
        cameras.  With real calibration, projects all bbox centers to the shared
        ground plane and merges points within DEDUP_RADIUS_MM.
        """
        if not detections_by_camera:
            return 0

        if not self.has_real_calibration():
            counts = [len(list(dets)) for dets in detections_by_camera.values()]
            max_count = max(counts) if counts else 0
            logger.debug(
                "No calibration — max dedup: per-camera counts=%s → %s", counts, max_count
            )
            return max_count

        projected_points: List[np.ndarray] = []
        for camera_id, detections in detections_by_camera.items():
            homography = self.homographies.get(camera_id, np.eye(3, dtype=np.float64))
            projected = self.project_to_ground(detections, homography)
            projected_points.extend(projected)

        clusters: List[np.ndarray] = []
        for point in projected_points:
            if not any(np.linalg.norm(point - cluster) <= DEDUP_RADIUS_MM for cluster in clusters):
                clusters.append(point)
        return len(clusters)
