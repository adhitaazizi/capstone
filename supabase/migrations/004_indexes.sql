CREATE INDEX idx_spindle_pass_session_status ON spindle_pass (session_id, status, entry_time);
CREATE INDEX idx_detection_event_spindle_time ON detection_event (spindle_pass_id, frame_timestamp);
CREATE INDEX idx_production_session_operator ON production_session (operator_id, start_time DESC);
