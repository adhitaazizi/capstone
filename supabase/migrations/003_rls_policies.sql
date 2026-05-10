ALTER TABLE spindle_pass ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read spindle_pass"
    ON spindle_pass FOR SELECT TO authenticated USING (true);

ALTER TABLE detection_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read detection_event"
    ON detection_event FOR SELECT TO authenticated USING (true);

ALTER TABLE production_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read production_session"
    ON production_session FOR SELECT TO authenticated USING (true);

ALTER TABLE camera ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read camera"
    ON camera FOR SELECT TO authenticated USING (true);

ALTER TABLE detection_model ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read detection_model"
    ON detection_model FOR SELECT TO authenticated USING (true);
