-- Cameras and models are referenced by detection_event's foreign keys below and
-- seeded by 006_seed.sql, but no migration ever created them, so this file
-- could not be applied to a clean database. They are created here, before the
-- tables that reference them.

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

CREATE TABLE production_session (
    session_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_label      VARCHAR(50),
    start_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
    end_time         TIMESTAMPTZ,
    total_spindles   INT NOT NULL DEFAULT 0,
    total_matched    INT NOT NULL DEFAULT 0,
    total_mismatched INT NOT NULL DEFAULT 0,
    operator_id      TEXT REFERENCES "user"(id)
);

-- The primary key is `pass_id`, not `spindle_pass_id`. Every consumer
-- (app/api/spindles, hooks/use-realtime, lib/inference/persistence) and the
-- seed in 009 assume `pass_id` + `toy_number`; this file originally declared
-- neither, so 009 could not be applied to a clean database. Databases created
-- before this correction are converted by 011_inference_pipeline.sql.
CREATE TABLE spindle_pass (
    pass_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES production_session(session_id),
    toy_number     VARCHAR(50) NOT NULL,
    entry_count    INT NOT NULL,
    exit_count     INT,
    entry_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_time      TIMESTAMPTZ,
    status         VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress','matched','mismatched')),
    mismatch_delta INT
);

CREATE TABLE detection_event (
    event_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID REFERENCES production_session(session_id),
    camera_id          INT NOT NULL REFERENCES camera(camera_id),
    model_id           INT NOT NULL REFERENCES detection_model(model_id),
    spindle_pass_id    UUID NOT NULL REFERENCES spindle_pass(pass_id),
    frame_timestamp    TIMESTAMPTZ NOT NULL,
    raw_count          INT NOT NULL,
    confidence_avg     FLOAT,
    processing_time_ms INT
);
