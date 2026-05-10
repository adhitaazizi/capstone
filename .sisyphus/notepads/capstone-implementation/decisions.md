Used three migration files to keep concerns separated: `003_rls_policies.sql`, `004_indexes.sql`, and `005_realtime.sql`.

Used `ALTER PUBLICATION supabase_realtime ADD TABLE ...` only for the requested tables: `spindle_pass` and `camera`.

## Persistence worker - 2026-05-10
- Added a minimal `rabbitmq` service to the new root `docker-compose.yml` because `persistence-worker.depends_on.rabbitmq` is invalid without a defined service. Defaults use guest credentials while preserving env override support.
- Failed persistence messages are negatively acknowledged with `requeue=False` to avoid poison-message loops; successful Supabase writes are acknowledged only after handler completion.
## Edge compute service decisions — 2026-05-10

- Roboflow requests use form-encoded `api_key` and `image` fields to match the specified API contract exactly; missing API keys return an empty detection result so MJPEG/health loops can continue during local simulation.
- Homography calibration is demo-mode identity for every configured camera, with `CrossCameraDeduplicator` accepting injected homography matrices for later real calibration.
- The orchestrator publishes entry/exit events through the canonical RabbitMQ exchanges/routing keys from the plan: `detection.events` with `entry.count`/`exit.count`, and `health` with topic keys for camera status and heartbeat.

## 2026-05-10 Observability stack
- Used RabbitMQ's built-in `rabbitmq_prometheus` plugin exposed on port `15692` and Prometheus scrape interval `15s`, matching the VPS monitoring requirement without adding Loki/Tempo.
- Provisioned Grafana datasource with UID `prometheus` and dashboards with UIDs `production-overview` and `system-health` so iframe URLs remain stable.
- Docker Compose exposes Grafana on host port `3001` while keeping the container port `3000`, avoiding conflict with the Next.js service on host port `3000`.
