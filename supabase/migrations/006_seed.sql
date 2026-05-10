-- Admin users must be created through the Better Auth API so passwords are hashed correctly.

INSERT INTO camera (camera_code, name, location, position_type, status, resolution) VALUES
    ('CAM-01', 'Cam-EN-T', 'Checkpoint A — Entry Top', 'entry', 'active', '1920x1080'),
    ('CAM-02', 'Cam-EN-S', 'Checkpoint A — Entry Side', 'entry', 'active', '1920x1080'),
    ('CAM-03', 'Cam-EX-T', 'Checkpoint B — Exit Top', 'exit', 'active', '1920x1080'),
    ('CAM-04', 'Cam-EX-S', 'Checkpoint B — Exit Side', 'exit', 'active', '1920x1080');

INSERT INTO detection_model (model_name, version, architecture, accuracy, is_active, deployed_at) VALUES
    ('SprayCount YOLO', '1', 'YOLO11', 0.95, true, now());
