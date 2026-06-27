
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
