-- Interval-sampled spindle counting with cross-camera pass pairing.
--
-- Two jobs:
--   1. Reconcile spindle_pass, whose shape has drifted between 002 and 009.
--   2. Extend detection_event to record how each count was arrived at, and to
--      make the cross-camera pairing query fast.
--
-- Idempotent and safe to run against either historical shape.

-- ---------------------------------------------------------------------------
-- 1. spindle_pass: converge on the pass_id + toy_number shape
-- ---------------------------------------------------------------------------
-- 002 created the PK as `spindle_pass_id`. 009 re-declares the table with
-- `pass_id` + `toy_number`, but guarded by IF NOT EXISTS, so on a clean
-- database 009 is a no-op and the 002 shape survives. Every piece of runtime
-- code (app/api/spindles, hooks/use-realtime, lib/inference/persistence)
-- assumes pass_id + toy_number, so converge on that regardless of which shape
-- the database currently holds.

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

ALTER TABLE spindle_pass
    ADD COLUMN IF NOT EXISTS toy_number VARCHAR(50);

-- 002 declared the PK without a default, so every insert had to supply one.
ALTER TABLE spindle_pass
    ALTER COLUMN pass_id SET DEFAULT gen_random_uuid();

-- Backfill before tightening, so the NOT NULL below cannot fail on old rows.
UPDATE spindle_pass
SET toy_number = 'SP-' || UPPER(LEFT(pass_id::text, 8))
WHERE toy_number IS NULL;

ALTER TABLE spindle_pass
    ALTER COLUMN toy_number SET DEFAULT 'SP-UNKNOWN';

-- ---------------------------------------------------------------------------
-- 2. detection_event: record the provenance of each count
-- ---------------------------------------------------------------------------
-- The pipeline keys cameras by their string code ('CAM-01'), not by camera's
-- SERIAL primary key, because that is the identifier the edge worker, Colab,
-- and Cloudflare track names all share. camera_id/model_id become optional.
--
-- Every column is added with IF NOT EXISTS, including ones 002 already
-- declares, because deployed databases were not all built from these
-- migrations — some carry a hand-rolled detection_event with session_id and no
-- spindle_pass_id at all. Adding first, then relaxing, converges both shapes.

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

-- An observation that cannot be paired to a spindle still has to be recorded,
-- and the pipeline identifies cameras by code rather than by the integer FKs.
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

-- Backfill camera_code for any pre-existing rows that used the integer FK.
UPDATE detection_event de
SET camera_code = c.camera_code
FROM camera c
WHERE de.camera_id = c.camera_id AND de.camera_code IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
-- The defining query of this feature: "give me both cameras' observations of
-- one physical spindle". Without this it is a sequential scan per spindle.
CREATE INDEX IF NOT EXISTS idx_detection_event_pass
    ON detection_event (spindle_pass_id);

CREATE INDEX IF NOT EXISTS idx_detection_event_camera_window
    ON detection_event (camera_code, window_start DESC);

-- Serves the dashboard's per-session pass table.
CREATE INDEX IF NOT EXISTS idx_spindle_pass_session_entry
    ON spindle_pass (session_id, entry_time DESC);
