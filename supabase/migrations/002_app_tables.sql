CREATE TABLE camera (
    camera_id     SERIAL PRIMARY KEY,
    camera_code   VARCHAR(10) NOT NULL UNIQUE,
    name          VARCHAR(50) NOT NULL,
    location      VARCHAR(100),
    position_type VARCHAR(10) NOT NULL CHECK (position_type IN ('entry','exit')),
    status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','inactive','error')),
    resolution    VARCHAR(20),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE detection_model (
    model_id      SERIAL PRIMARY KEY,
    model_name    VARCHAR(100) NOT NULL,
    version       VARCHAR(20) NOT NULL,
    architecture  VARCHAR(20) NOT NULL CHECK (architecture IN ('YOLO11','RT-DETR')),
    accuracy      FLOAT,
    mlflow_run_id VARCHAR(100),
    is_active     BOOLEAN NOT NULL DEFAULT false,
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

CREATE TABLE spindle_pass (
    spindle_pass_id UUID PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES production_session(session_id),
    entry_count     INT NOT NULL,
    exit_count      INT,
    entry_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_time       TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','matched','mismatched')),
    mismatch_delta  INT
);

CREATE TABLE detection_event (
    event_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id          INT NOT NULL REFERENCES camera(camera_id),
    model_id           INT NOT NULL REFERENCES detection_model(model_id),
    spindle_pass_id    UUID NOT NULL REFERENCES spindle_pass(spindle_pass_id),
    frame_timestamp    TIMESTAMPTZ NOT NULL,
    raw_count          INT NOT NULL,
    confidence_avg     FLOAT,
    processing_time_ms INT
);
