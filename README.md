# SprayCount — Automatic Spindle Counting System

An industrial edge-AI system that counts toys on spindles passing through a spray painting station. Entry and exit cameras detect the number of toys on each spindle using a YOLO model; a mismatch between the two counts signals that toys were lost during painting.

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

The spray painting line moves spindles (metal rods holding toys) through a paint booth. Two camera pairs sit at the entry and exit checkpoints:

```
  [Entry Cameras]                        [Exit Cameras]
  CAM-01 (top)   ──┐                ┌── CAM-03 (top)
  CAM-02 (side)  ──┤   SPRAY ZONE   ├── CAM-04 (side)
                   └────────────────┘
```

For every spindle:
- **Entry count** = toys detected by entry cameras before painting
- **Exit count** = toys detected by exit cameras after painting
- **Matched** = entry count equals exit count (no toys lost)
- **Mismatched** = counts differ (toys fell off during painting)

Each work day has **3 shifts** running 24 hours, Monday through Saturday:

| Shift | Time Window |
|-------|------------|
| S1    | 00:00 – 08:40 |
| S2    | 08:40 – 15:45 |
| S3    | 15:45 – 00:00 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         EDGE LAYER                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Python Edge Service (services/edge/)                    │  │
│  │  1. Capture frames from 4 cameras (USB / RTSP)          │  │
│  │  2. Send frames to Roboflow API for YOLO inference       │  │
│  │  3. Deduplicate overlapping detections (homography)      │  │
│  │  4. FIFO reconciler pairs entry <-> exit counts         │  │
│  │  5. Publish spindle.entry / spindle.exit events         │  │
│  │  6. Stream live MJPEG video on :8080                    │  │
│  └──────────────────────┬───────────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────────┘
                          │ RabbitMQ (AMQP)
┌─────────────────────────▼───────────────────────────────────────┐
│                      MESSAGE BUS                                 │
│  RabbitMQ  :5672 (AMQP)  |  :15672 (Management UI)            │
│  Exchanges: detection.events, health                            │
└──────────┬──────────────────────────────────────────────────────┘
           │
    ┌──────┴──────┐
    │             │
    ▼             ▼
┌────────────┐  ┌──────────────────────────────────────────────┐
│ Persistence│  │          Next.js Dashboard (:3000)           │
│  Worker    │  │  - Production dashboard (real-time)          │
│            │  │  - Live camera streams                       │
│ Consumes   │  │  - Reports & analytics (supervisor/admin)    │
│ RabbitMQ   │  │  - Device management (admin)                 │
│ events     │  │  - User management (admin)                   │
│            │  └────────────────────┬─────────────────────────┘
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

### Data Flow

1. Edge service captures camera frames at the configured FPS
2. Frames are sent to the Roboflow inference API (YOLO11 model)
3. Detections from overlapping camera pairs are deduplicated via homography
4. A FIFO reconciler matches each entry detection with the next exit detection
5. Persistence worker consumes the paired event from RabbitMQ and writes a `spindle_pass` record to Supabase
6. The Next.js dashboard receives the update via Supabase Realtime WebSocket and updates live

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web framework | Next.js 16 (App Router), React 19, TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Authentication | better-auth 1.6 (email/password, role-based) |
| Database | Supabase PostgreSQL + Realtime |
| Edge service | Python 3.12, OpenCV, Roboflow Inference SDK |
| Message bus | RabbitMQ 4.1 |
| Media routing | MediaMTX (RTSP → WebRTC / HLS / MJPEG) |
| AI inference | Roboflow hosted API (YOLO11 model) |
| Monitoring | Prometheus, Grafana |
| Runtime | Bun (Next.js build & dev), Docker Compose |

---

## Directory Structure

```
capstone/
├── app/                        # Next.js App Router
│   ├── (dashboard)/            # Authenticated dashboard layout
│   │   ├── page.tsx            # Production dashboard (operators+)
│   │   ├── cameras/page.tsx    # Live camera feeds
│   │   ├── reports/page.tsx    # Analytics & export (supervisor+)
│   │   ├── devices/page.tsx    # Camera & model management (admin)
│   │   └── settings/page.tsx   # User management (admin)
│   ├── api/                    # REST API routes
│   │   ├── sessions/           # Production session CRUD
│   │   ├── spindles/           # Spindle pass queries
│   │   ├── detections/         # Detection event log
│   │   ├── reports/            # Report generation & CSV/PDF export
│   │   └── users/              # User management
│   └── login/page.tsx          # Login page
│
├── components/                 # Shared UI components
│   ├── ui/                     # stat-card, button, badge, table...
│   ├── sidebar.tsx             # Navigation sidebar
│   └── ...
│
├── hooks/
│   ├── use-session.ts          # Auth session + role helpers
│   └── use-realtime.ts         # Supabase Realtime subscription
│
├── lib/
│   ├── auth.ts                 # better-auth server config
│   ├── auth-client.ts          # better-auth browser client
│   └── supabase/               # Supabase server & browser clients
│
├── services/
│   ├── edge/                   # Python edge inference service
│   │   ├── main.py             # Orchestrator entry point
│   │   ├── frame_capture.py    # Camera frame acquisition
│   │   ├── inference.py        # Roboflow API client
│   │   ├── deduplication.py    # Cross-camera deduplication
│   │   ├── reconciler.py       # Entry/exit FIFO matching
│   │   ├── publisher.py        # RabbitMQ publisher
│   │   └── mjpeg_server.py     # Live stream HTTP server
│   │
│   └── persistence/            # Python RabbitMQ consumer
│       ├── main.py             # Entry point with reconnect loop
│       ├── consumer.py         # Spindle event consumer
│       └── persistence.py      # Supabase write layer
│
├── supabase/migrations/        # Ordered SQL migrations
│   ├── 001_better_auth.sql     # Auth tables (user, session, account)
│   ├── 002_app_tables.sql      # production_session, spindle_pass, detection_event
│   ├── 003_rls_policies.sql    # Row Level Security policies
│   ├── 004_indexes.sql         # Performance indexes
│   ├── 005_realtime.sql        # Enable Realtime on key tables
│   ├── 006_seed.sql            # Camera and model reference data
│   ├── 007_seed_users.sql      # Test user accounts (optional)
│   ├── 008_detection_log.sql   # detection_event schema updates
│   ├── 009_seed_dashboard.sql  # Dashboard dummy data (Mon-Sat shifts)
│   └── 010_add_shift.sql       # shift_number column
│
├── monitoring/                 # Prometheus & Grafana config
├── docs/                       # Deployment & model handoff guides
├── docker-compose.yml          # Full stack orchestration
├── Dockerfile                  # Multi-stage Next.js build (Bun)
├── proxy.ts                    # Next.js middleware (auth + role routing)
└── .env.example                # All required environment variables
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- A [Supabase](https://supabase.com) project (free tier works)
- A [Roboflow](https://roboflow.com) account with the SprayCount YOLO11 model deployed

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `DATABASE_URL` | Direct PostgreSQL connection string |
| `AUTH_DATABASE_URL` | Connection string for better-auth (can be same as DATABASE_URL) |
| `BETTER_AUTH_SECRET` | Long random string for session signing |
| `BETTER_AUTH_URL` | App base URL (e.g. `http://localhost:3000`) |
| `ROBOFLOW_API_KEY` | Roboflow API key |
| `ROBOFLOW_MODEL_PROJECT` | Roboflow project name |
| `ROBOFLOW_MODEL_VERSION` | Model version number |
| `RABBITMQ_USER` / `RABBITMQ_PASS` | RabbitMQ credentials (default: guest/guest) |
| `GF_SECURITY_ADMIN_PASSWORD` | Grafana admin password |

See `.env.example` for the full list including camera, MediaMTX, and monitoring variables.

---

## Database Setup

Run the migrations **in order** in the Supabase SQL Editor:

```
001_better_auth.sql       <- Auth tables
002_app_tables.sql        <- Core app tables
003_rls_policies.sql      <- Row Level Security
004_indexes.sql           <- Indexes
005_realtime.sql          <- Enable Realtime
006_seed.sql              <- Camera & model reference data
007_seed_users.sql        <- Test accounts (optional)
008_detection_log.sql     <- detection_event schema updates
010_add_shift.sql         <- shift_number column
```

> Run `009_seed_dashboard.sql` separately after the app is running — see [Seeding Dummy Data](#seeding-dummy-data).

When prompted about Row Level Security, choose **Enable RLS** for safety. The app accesses tables via the service role key which bypasses RLS, so enabling it does not affect functionality.

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
| MJPEG camera streams | http://localhost:8080 |

### First login

Navigate to `http://localhost:3000` and register an account. The first user is created as `operator` by default. Upgrade your role in Supabase SQL Editor:

```sql
-- Promote to supervisor (Reports access)
UPDATE "user" SET role = 'supervisor' WHERE email = 'your@email.com';

-- Promote to admin (full access)
UPDATE "user" SET role = 'admin' WHERE email = 'your@email.com';
```

### Rebuilding after code changes

Docker caches layers aggressively. Always force a clean rebuild after code changes:

```bash
docker compose build --no-cache nextjs && docker compose up -d nextjs
```

---

## User Roles & Access

| Role | Dashboard | Live Cameras | Reports | Devices | Settings | Monitoring |
|------|:---------:|:------------:|:-------:|:-------:|:--------:|:----------:|
| `operator` | Yes | Yes | No | No | No | No |
| `supervisor` | Yes | Yes | Yes | No | No | No |
| `admin` | Yes | Yes | Yes | Yes | Yes | Yes |

Access control is enforced at three independent layers:
1. **Sidebar** (`components/sidebar.tsx`) — restricted nav items are hidden
2. **Middleware** (`proxy.ts`) — blocks the route at the routing layer, redirects to `/unauthorized`
3. **API routes** — each restricted endpoint verifies the role server-side before returning data

---

## Production Concepts

### Session (Shift)
A `production_session` represents one work shift. The operator clicks **START OPERATION** to open a session and **STOP** to close it. All spindle passes recorded while the session is open belong to that session.

### Spindle Pass
Each time a spindle travels through the spray zone, one `spindle_pass` record is written:

| Field | Description |
|-------|-------------|
| `toy_number` | Product code / SKU of the toys on the spindle (e.g. `HW-A101`) |
| `entry_count` | Toys detected at the entry checkpoint |
| `exit_count` | Toys detected at the exit checkpoint (`null` if still in zone) |
| `status` | `matched`, `mismatched`, or `in_progress` |
| `mismatch_delta` | `exit_count - entry_count` (negative = toys lost) |

### Shift Schedule (Mon – Sat, 24h)

| Shift | Start | End |
|-------|-------|-----|
| S1 | 00:00 | 08:40 |
| S2 | 08:40 | 15:45 |
| S3 | 15:45 | 00:00 |

---

## Dashboard Features

The production dashboard (`/`) is accessible to all roles and updates in real time.

**Stat cards**

| Card | Meaning |
|------|---------|
| Total Spindles | Count of spindle passes in the current session |
| Matched | Passes where `entry_count = exit_count` |
| Mismatched | Passes where toys were lost |
| Match Rate | `matched ÷ (matched + mismatched) × 100%` (excludes in-progress) |

**Spindle Passes table** — columns: Toy Number · Entry Count · Exit Count · Delta · Entry Time · Status

**Header** shows the active shift and date, e.g.:
> Shift 2 • Thursday, 19 June 2026

**Realtime** — the dashboard subscribes to `spindle_pass` table changes via Supabase Realtime WebSocket. New rows appear instantly without a page refresh.

---

## Reports & Export

The Reports page (`/reports`) is restricted to `supervisor` and `admin` roles.

**Filters:** date range (from / to) + shift label (Shift 1 / Shift 2 / Shift 3)

**Summary cards:** total sessions, total spindles, total matched, mismatch rate with trend indicator

**Session table:** all production sessions in the filtered range with shift, start/end time, spindle counts, and Completed / In Progress badge

**Export:** download filtered data as **CSV** or **PDF** using the buttons in the top-right corner.

---

## Monitoring

Grafana at `http://localhost:3001` provides operational dashboards for:
- Camera health and frame capture rates
- Roboflow inference latency
- RabbitMQ queue depths and message rates
- Spindle pass throughput over time

Default admin credentials are set via `GF_SECURITY_ADMIN_PASSWORD` in your `.env`.

For VPS deployment details see `docs/vps-setup.md`. For ML model handoff procedures see `docs/MODEL_DEPLOYMENT.md`.

---

## Seeding Dummy Data

To populate the dashboard with realistic demo data without a physical production line:

1. Make sure the app is running and you are logged in
2. Click **START OPERATION** on the dashboard to open an active session
3. Run `supabase/migrations/009_seed_dashboard.sql` in the Supabase SQL Editor

The seed will:
- Add `shift_number` column if not yet present
- Create `spindle_pass` table if not yet present
- Close any other existing active sessions
- Create completed sessions for every past shift in the current Mon–Sat week (auto-detected from server time)
- Insert **12 spindle passes** across 3 toy numbers for the active session:

| Toy Number | Spindles | Matched | Mismatched | In Progress |
|------------|----------|---------|------------|-------------|
| HW-A101 | 5 | 4 | 1 (-1 toy) | 0 |
| HW-B205 | 4 | 3 | 1 (-2 toys) | 0 |
| HW-C300 | 3 | 2 | 0 | 1 |

To re-seed cleanly, simply re-run the same file — it closes existing active sessions before creating new ones.
