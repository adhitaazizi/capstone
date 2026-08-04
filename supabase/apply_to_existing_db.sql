-- ===========================================================================
-- One-off catch-up for the deployed SprayCount database.
--
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- It is NOT a new migration. The deployed database was not built from
-- supabase/migrations/ — its detection_event is a hand-rolled table
-- (event_id, session_id, frame_timestamp, raw_count, confidence_avg,
-- processing_time_ms) with no spindle_pass_id, camera_id, model_id or bboxes,
-- and it has no camera / detection_model tables at all. This script converges
-- it onto the same shape a clean migration run produces.
--
-- Every statement is guarded against both shapes and is safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables the deployed database is missing entirely
-- ---------------------------------------------------------------------------
-- `camera` is what /api/devices reads; its absence is why that page is broken.

CREATE TABLE IF NOT EXISTS camera (
    camera_id     SERIAL PRIMARY KEY,
    camera_code   VARCHAR(20)  NOT NULL UNIQUE,
    name          VARCHAR(50)  NOT NULL,
    location      VARCHAR(100),
    position_type VARCHAR(10)  NOT NULL CHECK (position_type IN ('entry','exit')),
    status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive','error')),
    resolution    VARCHAR(20),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS detection_model (
    model_id      SERIAL PRIMARY KEY,
    model_name    VARCHAR(100) NOT NULL,
    version       VARCHAR(20)  NOT NULL,
    architecture  VARCHAR(20)  NOT NULL,
    accuracy      FLOAT,
    mlflow_run_id VARCHAR(100),
    is_active     BOOLEAN      NOT NULL DEFAULT false,
    deployed_at   TIMESTAMPTZ
);

INSERT INTO camera (camera_code, name, location, position_type, status, resolution) VALUES
    ('CAM-01', 'Cam-EN-T', 'Checkpoint A — Entry Top',  'entry', 'active', '1920x1080'),
    ('CAM-02', 'Cam-EN-S', 'Checkpoint A — Entry Side', 'entry', 'active', '1920x1080'),
    ('CAM-03', 'Cam-EX-T', 'Checkpoint B — Exit Top',   'exit',  'active', '1920x1080'),
    ('CAM-04', 'Cam-EX-S', 'Checkpoint B — Exit Side',  'exit',  'active', '1920x1080')
ON CONFLICT (camera_code) DO NOTHING;

INSERT INTO detection_model (model_name, version, architecture, accuracy, is_active, deployed_at)
SELECT 'SprayCount RF-DETR Medium', '1', 'RF-DETR', 0.95, true, now()
WHERE NOT EXISTS (SELECT 1 FROM detection_model);

-- ---------------------------------------------------------------------------
-- 2. spindle_pass — already correct on the deployed database; guarded for others
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'spindle_pass' AND column_name = 'spindle_pass_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'spindle_pass' AND column_name = 'pass_id'
    ) THEN
        ALTER TABLE spindle_pass RENAME COLUMN spindle_pass_id TO pass_id;
    END IF;
END $$;

ALTER TABLE spindle_pass ADD COLUMN IF NOT EXISTS toy_number VARCHAR(50);
ALTER TABLE spindle_pass ALTER COLUMN pass_id SET DEFAULT gen_random_uuid();

UPDATE spindle_pass
SET toy_number = 'SP-' || UPPER(LEFT(pass_id::text, 8))
WHERE toy_number IS NULL;

ALTER TABLE spindle_pass ALTER COLUMN toy_number SET DEFAULT 'SP-UNKNOWN';

-- ---------------------------------------------------------------------------
-- 3. detection_event — add everything, then relax
-- ---------------------------------------------------------------------------
-- Columns are added unconditionally with IF NOT EXISTS (including ones a clean
-- migration run would already have) so this works against either shape. The
-- DROP NOT NULLs come after, by which point every column is guaranteed present.

ALTER TABLE detection_event
    ADD COLUMN IF NOT EXISTS session_id      UUID,
    ADD COLUMN IF NOT EXISTS spindle_pass_id UUID,
    ADD COLUMN IF NOT EXISTS camera_id       INT,
    ADD COLUMN IF NOT EXISTS model_id        INT,
    ADD COLUMN IF NOT EXISTS bboxes          JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS camera_code     VARCHAR(20),
    ADD COLUMN IF NOT EXISTS interval_count  INT,
    ADD COLUMN IF NOT EXISTS sample_count    INT,
    ADD COLUMN IF NOT EXISTS spindle_box     JSONB,
    ADD COLUMN IF NOT EXISTS window_start    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS window_end      TIMESTAMPTZ;

-- session_id is NOT NULL on the deployed database, but an unpairable
-- observation outside any shift still has to be recordable.
ALTER TABLE detection_event ALTER COLUMN spindle_pass_id DROP NOT NULL;
ALTER TABLE detection_event ALTER COLUMN camera_id       DROP NOT NULL;
ALTER TABLE detection_event ALTER COLUMN model_id        DROP NOT NULL;
ALTER TABLE detection_event ALTER COLUMN session_id      DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'detection_event'
          AND constraint_name = 'detection_event_spindle_pass_id_fkey'
    ) THEN
        ALTER TABLE detection_event
            ADD CONSTRAINT detection_event_spindle_pass_id_fkey
            FOREIGN KEY (spindle_pass_id) REFERENCES spindle_pass(pass_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'detection_event'
          AND constraint_name = 'detection_event_session_id_fkey'
    ) THEN
        ALTER TABLE detection_event
            ADD CONSTRAINT detection_event_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES production_session(session_id);
    END IF;
END $$;

UPDATE detection_event de
SET camera_code = c.camera_code
FROM camera c
WHERE de.camera_id = c.camera_id AND de.camera_code IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
-- The defining query of this feature: both cameras' observations of one spindle.
CREATE INDEX IF NOT EXISTS idx_detection_event_pass
    ON detection_event (spindle_pass_id);
CREATE INDEX IF NOT EXISTS idx_detection_event_camera_window
    ON detection_event (camera_code, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_spindle_pass_session_entry
    ON spindle_pass (session_id, entry_time DESC);

-- ---------------------------------------------------------------------------
-- 5. Confirm
-- ---------------------------------------------------------------------------
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'detection_event'
ORDER BY ordinal_position;
