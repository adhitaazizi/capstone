"""Smoke tests for CrossCameraDeduplicator."""

import json
import tempfile
from pathlib import Path

import numpy as np
from deduplication import CrossCameraDeduplicator

# --- 1. Fallback: no JSON file → empty homographies → max() mode
print("=== Test 1: fallback (no JSON) ===")
d = CrossCameraDeduplicator(json_path="nonexistent.json")
assert d.homographies == {}, "Expected empty dict"
assert not d.has_real_calibration(), "Empty dict should report no calibration"
# Both cameras see same 1 toy → max(1,1) = 1
count = d.deduplicate_pair("CAM-01", [{"x": 0, "y": 0}], "CAM-02", [{"x": 5, "y": 5}])
assert count == 1, f"Expected 1, got {count}"
print(f"  dedup count (max fallback): {count}")

# --- 2. Load real homography from JSON
print("=== Test 2: load from JSON ===")
H = np.eye(3, dtype=np.float64)
H[0, 2] = 1000.0  # translate X by 1000mm — points will be far apart
with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
    json.dump({"CAM-01": H.tolist(), "CAM-02": np.eye(3).tolist()}, f)
    tmp_path = f.name

d2 = CrossCameraDeduplicator(json_path=tmp_path)
assert "CAM-01" in d2.homographies, "CAM-01 not loaded"
assert "CAM-02" in d2.homographies, "CAM-02 not loaded"
assert d2.has_real_calibration(), "Non-identity H for CAM-01 should report real calibration"
print(f"  Loaded cameras: {list(d2.homographies.keys())}")

# CAM-01 translated +1000mm in X → far from CAM-02 → 2 separate clusters
count2 = d2.deduplicate_pair("CAM-01", [{"x": 0, "y": 0}], "CAM-02", [{"x": 0, "y": 0}])
assert count2 == 2, f"Expected 2, got {count2}"
print(f"  dedup count (translated H): {count2}")

# --- 3. identity_for demo mode → max() fallback
print("=== Test 3: identity_for max() fallback ===")
d3 = CrossCameraDeduplicator.identity_for(["CAM-01", "CAM-02"])
assert all(np.allclose(v, np.eye(3)) for v in d3.homographies.values())
assert not d3.has_real_calibration(), "identity_for should report no real calibration"

# 2 spindles seen by both cameras simultaneously → max(2, 2) = 2
two_spindles = [{"x": 80, "y": 320}, {"x": 160, "y": 320}]
count3 = d3.deduplicate_pair("CAM-01", two_spindles, "CAM-02", two_spindles)
assert count3 == 2, f"Expected 2, got {count3}"
print(f"  dedup count (2 spindles, 2 cameras): {count3}")

# 1 camera misses a spindle → max(1, 2) = 2 (uses the better camera)
count3b = d3.deduplicate_pair("CAM-01", [two_spindles[0]], "CAM-02", two_spindles)
assert count3b == 2, f"Expected 2, got {count3b}"
print(f"  dedup count (cam1 misses 1, cam2 sees 2): {count3b}")

# --- 4. max() fallback with empty/single camera
print("=== Test 4: edge cases ===")
count4a = d3.deduplicate_many({})
assert count4a == 0, f"Expected 0 for empty, got {count4a}"

count4b = d3.deduplicate_many({"CAM-01": two_spindles})
assert count4b == 2, f"Expected 2, got {count4b}"
print(f"  empty dict → {count4a}, single cam with 2 spindles → {count4b}")

print("\nAll tests passed.")
