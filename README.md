# SprayCount — Automatic Spindle Counting System

An industrial edge-AI system that counts Hot Wheels toys on spindles passing through a spray painting station. Two cameras detect the number of toys at entry; a reconciler matches each entry to the corresponding exit count; mismatches flag potential toy loss during painting.

**Project:** Capstone Design — President University, Faculty of Computer Science  
**Group:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**Advisor:** Deffa Rahadiyan, S.Si.

For detailed system design see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Directory Structure](#directory-structure)
5. [Prerequisites](#prerequisites)
6. [Environment Variables](#environment-variables)
7. [Database Setup](#database-setup)
8. [Running the System](#running-the-system)
9. [User Roles & Access](#user-roles--access)
10. [Production Concepts](#production-concepts)
11. [Dashboard Features](#dashboard-features)
12. [Reports & Export](#reports--export)
13. [Monitoring](#monitoring)
14. [Seeding Dummy Data](#seeding-dummy-data)

---

## System Overview

The spray painting line moves spindles (metal rods holding toys) through a paint booth. One camera pair sits at the entry checkpoint:

```
  [Entry Cameras]                        [Exit Cameras]
  CAM-01 (top view)  ──┐             ┌── CAM-02 (side view)
                        │  SPRAY ZONE │
                        └─────────────┘
```

For every spindle:
- **Entry count** = toys detected by CAM-01 before painting (full rotation observed)
- **Exit count** = toys detected by CAM-02 after painting
- **Matched** = entry count equals exit count
- **Mismatched** = counts differ (toys may have fallen off during painting)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          EDGE LAYER                               │
│                                                                    │
│  Roboflow Inference Server (:9001)   ←── host machine, CPU-only   │
│         ↑ http inference calls (~620 ms each)                      │
│                                                                    │
│  Python Edge Worker (services/edge/)                               │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  FrameCapture × 2          reads frames at 15 fps          │   │
│  │  TrackingStream × 2        per-camera inference + flow     │   │
│  │    ├─ InferenceThread      Roboflow calls @ ~0.8 fps/cam   │   │
│  │    │   (serialized via class-level semaphore)              │   │
│  │    └─ FlowThread           center-point LK flow @ 10 fps  │   │
│  │  RowTracker                Y-cluster spindle rotation det. │   │
│  │  FIFOReconciler            matches entry ↔ exit counts     │   │
│  │  MJPEGServer (:8081)       raw video + /detections JSON    │   │
│  └──────────────────────────┬─────────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ RabbitMQ (AMQP)
┌─────────────────────────────▼──────────────────────────────────────┐
│                         MESSAGE BUS                                  │
│  RabbitMQ  :5672 (AMQP)  |  :15672 (Management UI)                │
└──────────┬──────────────────────────────────────────────────────────┘
           │
    ┌──────┴──────┐
    │             │
    ▼             ▼
┌────────────┐  ┌──────────────────────────────────────────────────┐
│ Persistence│  │          Next.js Dashboard (:3000)               │
│  Worker    │  │  - Production dashboard (real-time counts)       │
│            │  │  - Live camera feeds with bounding box overlay   │
│ Consumes   │  │  - Reports & analytics (supervisor/admin)        │
│ RabbitMQ   │  │  - Device management (admin)                     │
│ events     │  │  - User management (admin)                       │
│            │  └────────────────────┬─────────────────────────────┘
│ Writes to  │                       │
│ Supabase   │                       │
└─────┬──────┘                       │
      └──────────────┬───────────────┘
                     ▼
          ┌──────────────────┐
          │    Supabase      │
          │  PostgreSQL DB   │
          │  + Realtime WS   │
          └──────────────────┘
                     │
          ┌──────────▼──────────┐
          │  Monitoring Stack   │
          │  Prometheus  :9090  │
          │  Grafana     :3001  │
          └─────────────────────┘
```

### How counting works

1. **FrameCapture** reads each camera source (file or RTSP) at up to 15 fps
2. **TrackingStream inference thread** serializes Roboflow calls (one at a time, ~620 ms each) so the local server is never saturated. Each camera updates at ~0.8 fps (1.24 s interval)
3. **TrackingStream flow thread** runs Lucas-Kanade optical flow at 10 fps, tracking each detection's center point forward between ML ticks — this is what makes boxes follow cars visually rather than freezing for 1.24 s
4. **RowTracker** clusters detections by Y-position into rows; when a previously seen row reappears it declares a full spindle rotation complete
5. **_observe_spindle_entry** calls `RowTracker.add_frame()` every 500 ms until rotation is complete; the unique-row count = toys on the spindle
6. **FIFOReconciler** matches each entry event to the next exit event in order
7. **EdgePublisher** sends `spindle.entry` and `spindle.exit` events to RabbitMQ
8. **PersistenceWorker** writes `spindle_pass` records to Supabase
9. Next.js dashboard receives the insert via Supabase Realtime WebSocket

### Known inference constraint

The Roboflow local inference server runs on CPU and takes ~620 ms per call. With 2 cameras sharing a single semaphore, each camera receives a new ML result every ~1.24 s. Optical flow bridges this gap visually. A future upgrade path (see `weights/` and `services/edge/local_inference.py`) is to export the existing RT-DETR checkpoint to ONNX and replace the Roboflow server with direct ONNX Runtime inference, targeting ~50–100 ms per call on CPU.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web framework | Next.js 16 (App Router), React 19, TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Authentication | better-auth 1.6 (email/password, role-based) |
| Database | Supabase PostgreSQL + Realtime |
| Edge service | Python 3.12, OpenCV, PyAV, inference-sdk |
| ML inference | Roboflow local server (:9001) — Hot Wheels RT-DETR model |
| Visual tracking | Lucas-Kanade optical flow (center-point, 10 fps) |
| Message bus | RabbitMQ 4.1 |
| Media routing | MediaMTX (RTSP → MJPEG bridge) |
| Monitoring | Prometheus, Grafana |
| Runtime | Bun (Next.js build), Docker Compose |

---

## Directory Structure

```
capstone/
├── app/                            # Next.js App Router
│   ├── (auth)/                     # Login, sign-up, forgot-password
│   ├── (dashboard)/                # Authenticated dashboard layout
│   │   ├── page.tsx                # Production dashboard (operators+)
│   │   ├── cameras/page.tsx        # Live feeds — CAM-01 & CAM-02
│   │   ├── reports/page.tsx        # Analytics & CSV/PDF export (supervisor+)
│   │   ├── devices/page.tsx        # Device management (admin)
│   │   └── settings/page.tsx       # User management (admin)
│   └── api/
│       ├── edge/detections/[cameraId]/  # Proxies /detections/{id} from edge-worker:8081
│       ├── stream/[cameraId]/           # Proxies MJPEG from edge-worker:8081
│       └── sessions/ spindles/ reports/ users/
│
├── components/
│   ├── camera-tile.tsx             # Live feed + canvas bounding-box overlay
│   ├── local-camera-grid.tsx       # Grid layout for camera tiles
│   └── ui/                         # badge, button, input, modal, stat-card, table
│
├── services/
│   ├── edge/                       # Python edge-compute service (Docker)
│   │   ├── main.py                 # EdgeOrchestrator — entry/exit loops, health
│   │   ├── frame_capture.py        # FrameCapture — RTSP (PyAV) + file (OpenCV)
│   │   ├── tracking_stream.py      # TrackingStream — inference + LK flow threads
│   │   ├── row_tracker.py          # RowTracker — Y-cluster spindle rotation
│   │   ├── inference.py            # RoboflowInference — local server client
│   │   ├── local_inference.py      # LocalRTDETRInference — direct .pth/.onnx path
│   │   ├── mjpeg_server.py         # MJPEGServer — /stream and /detections endpoints
│   │   ├── deduplication.py        # CrossCameraDeduplicator (identity mode, 2-cam)
│   │   ├── reconciler.py           # FIFOReconciler — entry/exit matching
│   │   ├── publisher.py            # EdgePublisher — RabbitMQ AMQP
│   │   ├── config.py               # EdgeConfig — env var loading
│   │   └── rtsp_mjpeg_bridge.py    # Standalone RTSP→MJPEG bridge (rtsp-bridge svc)
│   │
│   └── persistence/                # Python RabbitMQ consumer (Docker)
│       ├── main.py                 # Entry point with reconnect loop
│       ├── consumer.py             # Spindle event consumer
│       └── persistence.py          # Supabase write layer
│
├── weights/
│   ├── README.md                   # Model artifact notes
│   └── checkpoint_best_total.pth   # RT-DETR checkpoint (local inference)
│
├── supabase/migrations/            # Ordered SQL migrations (001–010)
├── monitoring/                     # Prometheus & Grafana config
├── docs/                           # Architecture & deployment guides
├── docker-compose.yml              # Full stack orchestration
└── Dockerfile                      # Multi-stage Next.js build (Bun)
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- A [Supabase](https://supabase.com) project (free tier)
- A Roboflow local inference server running on the host at port 9001 with the Hot Wheels model loaded

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side) |
| `DATABASE_URL` | Direct PostgreSQL connection string |
| `AUTH_DATABASE_URL` | Connection string for better-auth |
| `BETTER_AUTH_SECRET` | Long random string for session signing |
| `BETTER_AUTH_URL` | App base URL (e.g. `http://localhost:3000`) |
| `ROBOFLOW_API_KEY` | Roboflow API key |
| `ROBOFLOW_MODEL_PROJECT` | Roboflow project slug |
| `ROBOFLOW_MODEL_VERSION` | Model version number |
| `CONFIDENCE_THRESHOLD` | Detection confidence cutoff (default `0.75`) |
| `CAM_01_SOURCE` | Path or RTSP URL for entry camera (default: `spindle-simulation.mp4`) |
| `CAM_02_SOURCE` | Path or RTSP URL for exit camera |
| `RABBITMQ_USER` / `RABBITMQ_PASS` | RabbitMQ credentials (default: guest/guest) |
| `GF_SECURITY_ADMIN_PASSWORD` | Grafana admin password |

---

## Database Setup

Run migrations **in order** in the Supabase SQL Editor:

```
001_better_auth.sql      ← Auth tables
002_app_tables.sql       ← Core app tables
003_rls_policies.sql     ← Row Level Security
004_indexes.sql          ← Indexes
005_realtime.sql         ← Enable Realtime
006_seed.sql             ← Camera & model reference data
007_seed_users.sql       ← Test accounts (optional)
008_detection_log.sql    ← detection_event schema updates
010_add_shift.sql        ← shift_number column
```

Run `009_seed_dashboard.sql` separately after the app is running to populate demo data.

---

## Running the System

### Start all services

```bash
docker compose up -d --build
```

| Service | URL |
|---------|-----|
| Next.js dashboard | http://localhost:3000 |
| Grafana | http://localhost:3001 |
| RabbitMQ management | http://localhost:15672 |
| Prometheus | http://localhost:9090 |
| Edge MJPEG streams | http://localhost:8081/stream/CAM-01 |
| Edge detections JSON | http://localhost:8081/detections/CAM-01 |

> The Roboflow local inference server must already be running on the host at `localhost:9001` before starting the stack.

### Rebuild after code changes

Python and TypeScript changes require a rebuild (code is baked into the Docker image):

```bash
# Edge service only
docker compose up -d --build edge-worker

# Next.js only
docker compose up -d --build nextjs

# Both
docker compose up -d --build edge-worker nextjs
```

### First login

Navigate to `http://localhost:3000`. Register an account — the first user is created as `operator`. Promote in Supabase:

```sql
UPDATE "user" SET role = 'admin' WHERE email = 'your@email.com';
```

---

## User Roles & Access

| Role | Dashboard | Live Cameras | Reports | Devices | Settings |
|------|:---------:|:------------:|:-------:|:-------:|:--------:|
| `operator` | Yes | Yes | No | No | No |
| `supervisor` | Yes | Yes | Yes | No | No |
| `admin` | Yes | Yes | Yes | Yes | Yes |

Access control is enforced at three layers: sidebar (hidden nav), middleware (`proxy.ts`, route-level redirect), and API routes (server-side role check).

---

## Production Concepts

### Session (Shift)
A `production_session` represents one work shift. The operator clicks **START OPERATION** to open a session and **STOP** to close it.

### Spindle Pass
Each spindle through the spray zone produces one `spindle_pass` record:

| Field | Description |
|-------|-------------|
| `entry_count` | Toys detected at entry (RowTracker full-rotation count) |
| `exit_count` | Toys detected at exit (null if still in zone) |
| `status` | `matched`, `mismatched`, or `in_progress` |
| `mismatch_delta` | `exit_count − entry_count` (negative = toys lost) |

### Shift Schedule (Mon–Sat, 24h)

| Shift | Start | End |
|-------|-------|-----|
| S1 | 00:00 | 08:40 |
| S2 | 08:40 | 15:45 |
| S3 | 15:45 | 00:00 |

---

## Dashboard Features

- **Stat cards** — Total Spindles, Matched, Mismatched, Match Rate
- **Spindle Passes table** — Entry Count · Exit Count · Delta · Entry Time · Status
- **Live cameras** — MJPEG video with canvas bounding-box overlay, polled at 100 ms
- **Realtime** — Supabase Realtime WebSocket pushes new rows without page refresh

---

## Reports & Export

The Reports page (`/reports`, supervisor+ only) supports date-range and shift filtering, session table with status badges, and **CSV / PDF export**.

---

## Monitoring

Grafana at `http://localhost:3001` provides dashboards for camera health, inference latency, RabbitMQ queue depth, and spindle throughput.

---

## Seeding Dummy Data

1. Start the app, click **START OPERATION** to open a session
2. Run `supabase/migrations/009_seed_dashboard.sql` in Supabase SQL Editor

The seed inserts 12 spindle passes across 3 toy types for the active session and creates completed sessions for every past shift in the current Mon–Sat week.
