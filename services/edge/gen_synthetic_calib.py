"""Generate synthetic checkerboard calibration images for testing camera_calibration.py."""

import json
from pathlib import Path

import cv2
import numpy as np

CHECKERBOARD = (9, 6)
SQUARE_SIZE_MM = 25.0
IMG_W, IMG_H = 1280, 960

# Known ground-truth homography: scale + small translation (pixels -> mm)
# This simulates a camera looking straight down at the ground plane
SCALE = 0.5  # 1 pixel ~ 0.5 mm
GT_H = np.array([
    [SCALE,  0.0,  -50.0],
    [0.0,  SCALE,  -30.0],
    [0.0,    0.0,    1.0],
], dtype=np.float64)


def world_to_pixel(world_pts: np.ndarray, H_inv: np.ndarray) -> np.ndarray:
    """Project world (mm) -> pixel using inverse homography."""
    n = len(world_pts)
    hom = np.hstack([world_pts, np.ones((n, 1))])
    px = (H_inv @ hom.T).T
    return px[:, :2] / px[:, 2:3]


def make_image(board_origin_mm: np.ndarray, angle_deg: float) -> np.ndarray:
    """Render a synthetic checkerboard image."""
    cols, rows = CHECKERBOARD
    # World coords of all inner corners
    grid_x = np.tile(np.arange(cols), rows) * SQUARE_SIZE_MM + board_origin_mm[0]
    grid_y = np.repeat(np.arange(rows), cols) * SQUARE_SIZE_MM + board_origin_mm[1]
    world_pts = np.stack([grid_x, grid_y], axis=1).astype(np.float64)

    # Apply small rotation in world plane
    rad = np.deg2rad(angle_deg)
    R = np.array([[np.cos(rad), -np.sin(rad)],
                  [np.sin(rad),  np.cos(rad)]])
    cx, cy = board_origin_mm[0] + cols * SQUARE_SIZE_MM / 2, board_origin_mm[1] + rows * SQUARE_SIZE_MM / 2
    world_pts_rot = (R @ (world_pts - [cx, cy]).T).T + [cx, cy]

    H_inv = np.linalg.inv(GT_H)
    px_pts = world_to_pixel(world_pts_rot, H_inv).astype(np.float32)

    img = np.ones((IMG_H, IMG_W), dtype=np.uint8) * 200
    sq_px = int(SQUARE_SIZE_MM / SCALE)

    # Draw filled squares for black cells
    for r in range(rows + 1):
        for c in range(cols + 1):
            world_corner = np.array([[
                board_origin_mm[0] + c * SQUARE_SIZE_MM - SQUARE_SIZE_MM,
                board_origin_mm[1] + r * SQUARE_SIZE_MM - SQUARE_SIZE_MM,
            ]], dtype=np.float64)
            world_corner_rot = (R @ (world_corner - [cx, cy]).T).T + [cx, cy]
            px = world_to_pixel(world_corner_rot, H_inv).astype(int)
            if (r + c) % 2 == 0:
                pts_sq = np.array([
                    px[0],
                    world_to_pixel((R @ (np.array([[board_origin_mm[0] + (c+1)*SQUARE_SIZE_MM - SQUARE_SIZE_MM,
                                                     board_origin_mm[1] + r*SQUARE_SIZE_MM - SQUARE_SIZE_MM]]) - [cx,cy]).T).T + [cx,cy], H_inv).astype(int)[0],
                    world_to_pixel((R @ (np.array([[board_origin_mm[0] + (c+1)*SQUARE_SIZE_MM - SQUARE_SIZE_MM,
                                                     board_origin_mm[1] + (r+1)*SQUARE_SIZE_MM - SQUARE_SIZE_MM]]) - [cx,cy]).T).T + [cx,cy], H_inv).astype(int)[0],
                    world_to_pixel((R @ (np.array([[board_origin_mm[0] + c*SQUARE_SIZE_MM - SQUARE_SIZE_MM,
                                                     board_origin_mm[1] + (r+1)*SQUARE_SIZE_MM - SQUARE_SIZE_MM]]) - [cx,cy]).T).T + [cx,cy], H_inv).astype(int)[0],
                ], dtype=np.int32).reshape(-1, 1, 2)
                cv2.fillPoly(img, [pts_sq], 0)

    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def main():
    out_root = Path("calibration_images")
    for cam_id in ["CAM-01", "CAM-02"]:
        cam_dir = out_root / cam_id
        cam_dir.mkdir(parents=True, exist_ok=True)
        # slight offset per camera to simulate different positions
        offset = np.array([100.0, 80.0]) if cam_id == "CAM-01" else np.array([120.0, 90.0])
        for i, angle in enumerate(range(-15, 20, 5)):
            img = make_image(offset, angle)
            path = cam_dir / f"frame_{i:02d}.jpg"
            cv2.imwrite(str(path), img)
        print(f"Generated {len(list(cam_dir.glob('*.jpg')))} images for {cam_id}")

    # Save ground-truth homography for comparison
    Path("gt_homography.json").write_text(
        json.dumps({"GT_H": GT_H.tolist(), "scale_mm_per_px": SCALE}, indent=2)
    )
    print("Ground-truth saved to gt_homography.json")


if __name__ == "__main__":
    main()
