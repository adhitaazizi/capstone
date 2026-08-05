-- Live-editable pipeline tunables, replacing the .env-based thresholds in
-- lib/inference/constants.ts. Read by lib/inference/settings-store.ts, which
-- polls this table and applies changes to the running process without a
-- restart. Written by app/api/settings/route.ts (admin-only).
--
-- Secrets (INFERENCE_API_KEY, CF_APP_SECRET, CF_TURN_KEY_*) stay in .env —
-- this table is for non-secret, operator-tunable behavior only.

create table if not exists system_settings (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now(),
  updated_by text references "user"(id)
);

insert into system_settings (key, value, description) values
  ('DETECTION_INTERVAL_MS', '2000', 'Sampling window width in ms. Must span at least one full spindle rotation.'),
  ('MAX_HOTWHEELS', '8', 'Physical capacity of one spindle. Samples above this are dropped as implausible, not clamped.'),
  ('SPINDLE_BOUNDARY_MARGIN', '0.15', 'Containment tolerance in spindle-relative units.'),
  ('SPINDLE_MIN_CONFIDENCE', '0.5', 'Minimum confidence to accept a spindle detection.'),
  ('HOTWHEELS_MIN_CONFIDENCE', '0.35', 'Minimum confidence to accept a hot-wheels detection.'),
  ('SPINDLE_ABSENT_INTERVALS', '1', 'Consecutive spindle-absent intervals required to close a visit.'),
  ('MAX_VISIT_INTERVALS', '15', 'Safety cap: force-closes a visit that never ends.'),
  ('ENTRY_CAMERA_ID', 'CAM-01', 'Camera id a spindle reaches first. The FIFO pairing depends on this order.'),
  ('EXIT_CAMERA_ID', 'CAM-02', 'Camera id a spindle reaches second.'),
  ('SPINDLE_ORPHAN_TIMEOUT_MS', '300000', 'A pending entry with no matching exit after this long is abandoned.'),
  ('QUEUE_MAX_DEPTH', '50', 'Bounds the FIFO cross-camera pairing queue.'),
  ('INFERENCE_CONFIDENCE', '0.35', 'RF-DETR confidence threshold, served to the GPU inference worker.'),
  ('INFERENCE_MAX_DETECTIONS', '100', 'Max detections kept per frame, served to the GPU inference worker.'),
  ('INFERENCE_TARGET_CLASS_NAMES', '', 'Comma-separated checkpoint class filter; empty keeps every class.'),
  ('INFERENCE_SHAPE', '', '"HEIGHT,WIDTH" fed to the model; empty uses the checkpoint default.')
on conflict (key) do nothing;
