"""Compute per-camera homography matrices from checkerboard calibration images.

Usage:
    python camera_calibration.py --images-dir calibration_images --square-size 25

Directory structure expected:
    calibration_images/
        CAM-01/
            frame_01.jpg
            frame_02.jpg
            ...
        CAM-02/
            ...

Each subdirectory name becomes the camera ID in homography_matrices.json.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import cv2
import numpy as np

CHECKERBOARD = (9, 6)  # inner corner count (cols, rows)
DEFAULT_OUTPUT = Path(__file__).parent / "homography_matrices.json"

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger("camera_calibration")


def _world_grid(square_size_mm: float) -> np.ndarray:
    """Real-world ground-plane coordinates for each checkerboard inner corner (mm)."""
    cols, rows = CHECKERBOARD
    pts = np.zeros((rows * cols, 2), dtype=np.float64)
    pts[:, 0] = np.tile(np.arange(cols), rows) * square_size_mm   # X
    pts[:, 1] = np.repeat(np.arange(rows), cols) * square_size_mm  # Y
    return pts


def _refine_corners(gray: np.ndarray, corners: np.ndarray) -> np.ndarray:
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    return cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)


def calibrate_camera(image_dir: Path, square_size_mm: float) -> np.ndarray | None:
    """Compute a single homography for one camera using all valid images in image_dir.

    Stacks all point correspondences and fits with RANSAC for robustness.
    Returns None if fewer than 1 image yields a valid checkerboard detection.
    """
    world_pts = _world_grid(square_size_mm)
    all_img_pts: list[np.ndarray] = []
    all_world_pts: list[np.ndarray] = []

    images = sorted(image_dir.glob("*.jpg")) + sorted(image_dir.glob("*.png"))
    if not images:
        logger.warning("No .jpg/.png images found in %s", image_dir)
        return None

    for img_path in images:
        img = cv2.imread(str(img_path))
        if img is None:
            logger.warning("Cannot read %s — skipping", img_path.name)
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        found, corners = cv2.findChessboardCorners(gray, CHECKERBOARD, None)
        if not found:
            logger.warning("Checkerboard not detected in %s — skipping", img_path.name)
            continue
        corners = _refine_corners(gray, corners)
        all_img_pts.append(corners.reshape(-1, 2))
        all_world_pts.append(world_pts)
        logger.info("  [OK] %s", img_path.name)

    if not all_img_pts:
        logger.error("No valid calibration frames in %s", image_dir)
        return None

    img_pts_stacked = np.vstack(all_img_pts).astype(np.float64)
    world_pts_stacked = np.vstack(all_world_pts).astype(np.float64)

    H, mask = cv2.findHomography(img_pts_stacked, world_pts_stacked, cv2.RANSAC, 5.0)
    if H is None:
        logger.error("findHomography failed for %s", image_dir.name)
        return None

    inliers = int(mask.sum()) if mask is not None else 0
    logger.info(
        "  Homography computed — %d / %d inliers (%.1f%%)",
        inliers,
        len(img_pts_stacked),
        100 * inliers / len(img_pts_stacked),
    )
    return H


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute per-camera homography matrices from 9x6 checkerboard images."
    )
    parser.add_argument(
        "--images-dir",
        default="calibration_images",
        help="Root directory with one sub-folder per camera ID (default: calibration_images/)",
    )
    parser.add_argument(
        "--square-size",
        type=float,
        default=25.0,
        help="Checkerboard square size in mm (default: 25)",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args()

    images_root = Path(args.images_dir)
    if not images_root.exists():
        logger.error("Images directory not found: %s", images_root.resolve())
        return

    results: dict[str, list] = {}
    camera_dirs = sorted(d for d in images_root.iterdir() if d.is_dir())
    if not camera_dirs:
        logger.error("No camera subdirectories found in %s", images_root)
        return

    for camera_dir in camera_dirs:
        camera_id = camera_dir.name
        logger.info("=== Calibrating %s ===", camera_id)
        H = calibrate_camera(camera_dir, args.square_size)
        if H is not None:
            results[camera_id] = H.tolist()
        else:
            logger.warning("Skipping %s — calibration failed", camera_id)

    if not results:
        logger.error("No cameras calibrated — nothing saved.")
        return

    output_path = Path(args.output)
    output_path.write_text(json.dumps(results, indent=2))
    logger.info("Saved homographies for %s to %s", list(results.keys()), output_path)


if __name__ == "__main__":
    main()
