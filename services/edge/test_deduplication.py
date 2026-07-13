"""Quick smoke test for CrossCameraDeduplicator homography loading."""

import json
import tempfile
from pathlib import Path

import numpy as np
from deduplication import CrossCameraDeduplicator

# --- 1. Fallback: no JSON file → should use identity silently
print("=== Test 1: fallback (no JSON) ===")
d = CrossCameraDeduplicator(json_path="nonexistent.json")
assert d.homographies == {}, "Expected empty dict"
count = d.deduplicate_pair("CAM-01", [{"x": 0, "y": 0}], "CAM-02", [{"x": 5, "y": 5}])
print(f"  dedup count (identity): {count}")  # 1 — both points close together

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
print(f"  Loaded cameras: {list(d2.homographies.keys())}")

# CAM-01 gets translated 1000mm in X → far from CAM-02 point → 2 separate clusters
count2 = d2.deduplicate_pair("CAM-01", [{"x": 0, "y": 0}], "CAM-02", [{"x": 0, "y": 0}])
print(f"  dedup count (translated H): {count2}")  # should be 2

# --- 3. Demo mode (identity_for) still works
print("=== Test 3: identity_for demo mode ===")
d3 = CrossCameraDeduplicator.identity_for(["CAM-01", "CAM-02"])
assert all(np.allclose(v, np.eye(3)) for v in d3.homographies.values())
print("  identity_for OK")

print("\nAll tests passed.")
