"""Cross-camera deduplication using homography projection."""

from __future__ import annotations

from typing import Dict, Iterable, List, Mapping, Sequence

import numpy as np

DEDUP_RADIUS_MM = 30.0


class CrossCameraDeduplicator:
    """Merge detections whose projected bbox centers are within 30mm."""

    def __init__(self, homographies: Mapping[str, np.ndarray] | None = None) -> None:
        self.homographies = dict(homographies or {})

    @classmethod
    def identity_for(cls, camera_ids: Iterable[str]) -> "CrossCameraDeduplicator":
        """Create demo-mode identity homographies for each camera."""

        return cls({camera_id: np.eye(3, dtype=np.float64) for camera_id in camera_ids})

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

        The orchestrator uses pairs per checkpoint, but this keeps the module
        useful if a checkpoint adds more cameras later.
        """

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
