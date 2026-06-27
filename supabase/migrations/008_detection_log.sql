-- Allow browser-side detections that are not linked to a spindle pass
ALTER TABLE detection_event ALTER COLUMN spindle_pass_id DROP NOT NULL;

-- Store bounding box details per event
ALTER TABLE detection_event ADD COLUMN IF NOT EXISTS bboxes JSONB NOT NULL DEFAULT '[]';
