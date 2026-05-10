# System Architecture
## Automatic Spray Counting System
**Project:** Capstone Design — President University, Faculty of Computer Science  
**Group:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**Advisor:** Deffa Rahadiyan, S.Si.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Top-Level Architecture](#2-top-level-architecture)
3. [Physical Layer](#3-physical-layer)
4. [Edge Compute Layer](#4-edge-compute-layer)
5. [Message Broker Layer (RabbitMQ)](#5-message-broker-layer-rabbitmq)
6. [Storage Layer (Supabase PostgreSQL)](#6-storage-layer-supabase-postgresql)
7. [Application Layer (Next.js Dashboard)](#7-application-layer-nextjs-dashboard)
8. [Observability Stack](#8-observability-stack)
9. [Data Flow — Normal Operation](#9-data-flow--normal-operation)
10. [Database Schema](#10-database-schema)
11. [API Contract](#11-api-contract)
13. [RabbitMQ Exchange & Queue Topology](#13-rabbitmq-exchange--queue-topology)
14. [Deployment Topology](#14-deployment-topology)
15. [Non-Functional Requirements Mapping](#15-non-functional-requirements-mapping)
16. [Component & Technology Reference](#16-component--technology-reference)

---

## 1. Overview

The Automatic Spray Counting System is an industrial edge-AI solution that replaces manual part counting at the spray painting line of PT. Mattel Indonesia. The system captures video from four IP65-rated USB 3.0 cameras, forwards frames to ESP32 edge compute modules, and sends images to the Roboflow API for cloud-based object detection. The ESP32 modules reconcile entry vs. exit counts through a FIFO queue and surface live metrics and live camera feeds on a Next.js web dashboard. All operational data is persisted in Supabase PostgreSQL, queried directly via the Supabase JS client (no ORM layer). Authentication and session management are handled by `better-auth`. Internal service communication uses RabbitMQ (AMQP). The full observability stack (Prometheus, Grafana, Loki, Tempo) runs alongside the application services.

### Key Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-01 | End-to-end detection latency | < 500 ms per frame |
| NFR-02 | Counting accuracy | ≥ 95 % mAP |
| NFR-03 | Dashboard refresh | ≤ 2 s after DB write |
| NFR-04 | System availability during production shifts | ≥ 99 % |
| NFR-05 | Camera disconnection tolerance | Graceful degradation; remaining streams continue |
| NFR-06 | Detection confidence threshold | > 0.85 (hard filter) |
| NFR-07 | Cross-camera deduplication radius | ≤ 30 mm Euclidean distance in ground plane |

---

## 2. Top-Level Architecture

```
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │                             PHYSICAL LAYER                                      │
  │                                                                                 │
  │  ┌─────────────────┐  USB 3.0   ┌───────────────────────────────────────────┐  │
  │  │   CHECKPOINT A  │───────────▶│                                           │  │
  │  │   (Entry)       │            │         ESP32 EDGE COMPUTE                │  │
  │  │   Cam-EN-T      │            │                                           │  │
  │  │   Cam-EN-S      │            │  ┌─────────────────────────────────────┐  │  │
  │  └─────────────────┘  USB 3.0   │  │      Inference Pipeline             │  │  │
  │                     ─────────▶ │  │  Frame Capture → Roboflow API →     │  │  │
  │  ┌─────────────────┐           │  │  Cross-Cam Dedup → FIFO Reconcile   │  │  │
  │  │   CHECKPOINT B  │───────────▶│  └─────────────────────────────────────┘  │  │
  │  │   (Exit)        │            │                                           │  │
  │  │   Cam-EX-T      │            │  ┌─────────────────────────────────────┐  │  │
  │  │   Cam-EX-S      │            │  │      MJPEG Stream Server            │  │  │
  │  └─────────────────┘            │  └─────────────────────────────────────┘  │  │
  │                                 └───────────────────────────────────────────┘  │
  │                                              │ AMQP                           │
  │                                              ▼                                │
  └───────────────────────────────────────────────────────────────────────────────┘
                                        │ AMQP (TLS)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          MESSAGE BROKER LAYER                                   │
│                                                                                 │
│                         RabbitMQ  (AMQP 0-9-1)                                 │
│                                                                                 │
│   exchange: detection.events                     exchange: health              │
│   queue: entry.counts                            queue: camera.health          │
│   queue: exit.counts                             queue: model.health           │
└─────────────────────────────────────────────────────────────────────────────────┘
          │                                               │
          │ AMQP consumer                                 │ AMQP consumer
          ▼                                               ▼
┌──────────────────┐                          ┌───────────────────────────────┐
│  STORAGE LAYER   │                          │     OBSERVABILITY STACK       │
│                  │                          │                               │
│  Supabase        │                          │  Prometheus  (metrics)        │
│  PostgreSQL      │                          │  Grafana     (dashboards)     │
│  + Realtime WS   │                          │  Loki        (logs)           │
│  + Row-Level Sec │                          │  Tempo       (traces)         │
└──────────────────┘                          └───────────────────────────────┘
          │
          │ REST / Supabase Realtime
          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                                       │
│                                                                                 │
│                        Next.js Dashboard                                        │
│                                                                                 │
│   - Operator view   (live counts, camera feeds)                                 │
│   - Supervisor view (reports, audit logs)                                       │
│   - Admin view      (model management, device config, user management)          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Physical Layer

### 3.1 Camera Configuration

| ID | Label | Position | Resolution | FPS | Interface | Enclosure |
|----|-------|----------|------------|-----|-----------|-----------|
| CAM-01 | Cam-EN-T | Checkpoint A — Entry Top | 1920×1080 | 30 | USB 3.0 | IP65 |
| CAM-02 | Cam-EN-S | Checkpoint A — Entry Side | 1920×1080 | 30 | USB 3.0 | IP65 |
| CAM-03 | Cam-EX-T | Checkpoint B — Exit Top | 1920×1080 | 30 | USB 3.0 | IP65 |
| CAM-04 | Cam-EX-S | Checkpoint B — Exit Side | 1920×1080 | 30 | USB 3.0 | IP65 |

Each pair (EN-T + EN-S, EX-T + EX-S) has optical axes diverging by ~45°, giving full 360° coverage of the cylindrical spindle hook. This eliminates the occlusion blind-spot present in single-camera setups.

### 3.2 ESP32 Edge Compute Module

Each checkpoint (A and B) is served by a dedicated ESP32-S3 module with USB-OTG host capability and Wi-Fi connectivity.

```
Conveyor Proximity Sensor
        │
        ▼
    [ ESP32-S3 ]◀──── USB 3.0 ──── Cam-EN-T / Cam-EN-S (Checkpoint A)
        │                               or
        │◀─────────────────────────── Cam-EX-T / Cam-EX-S (Checkpoint B)
        │
        ├── Wi-Fi ──▶ Roboflow Inference API (HTTPS / REST)
        │
        ├── Wi-Fi ──▶ RabbitMQ Publisher (AMQP over TLS)
        │
        ├── Wi-Fi ──▶ MJPEG Stream Server ──▶ Next.js Dashboard
        │
        └── (Optional) NTP sync ──▶ Timestamp alignment with VPS
```

- **Role:** Edge inference coordinator; ingests two parallel USB 3.0 video streams per module.
- **Latency budget:** ≤ 500 ms end-to-end per spindle pass (ESP32 → Roboflow → result).
- **Key services running on ESP32 (FreeRTOS tasks):**
  - `frame-capture` — ESP32-Camera / USB-UVC driver, one task per camera
  - `ai-inference` — HTTPS client posting base64-encoded frames to Roboflow API
  - `dedup-service` — Cross-camera homography-based coordinate fusion (lightweight NumPy/C equivalent)
  - `fifo-reconciler` — Fixed-size ring buffer FIFO queue logic
  - `rabbitmq-publisher` — AMQP publisher to the remote broker
  - `mjpeg-server` — Lightweight HTTP server streaming MJPEG for live dashboard feeds
  - `health-telemetry` — Periodic health metrics to `health.esp32` RabbitMQ queue every 5 s

---

## 4. Edge Compute Layer

### 4.1 Inference Pipeline (per spindle pass)

```
Proximity Sensor Trigger
        │
        ▼
┌─────────────────────┐
│  Frame Capture &    │  Both cameras at the checkpoint fire on trigger.
│  Synchronization    │  Frames are JPEG-compressed and base64-encoded.
│  (ESP32-Camera lib) │
└────────┬────────────┘
         │ 2× (base64_frame, camera_id, timestamp)
         ▼
┌─────────────────────┐
│   Preprocessing     │  Resize to model input size (640×640).
│   (ESP32 DSP /      │  Encode as base64 JSON payload.
│    lightweight ops) │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   AI Inference      │  HTTPS POST to Roboflow Inference API.
│   (Roboflow API)    │  Model: hosted YOLO / RT-DETR project.
│                     │  Output: [bbox, class, confidence] per detection.
│                     │  Filter: confidence < 0.85 → discard.
└────────┬────────────┘
         │ JSON detection result
         ▼
┌─────────────────────┐
│  Cross-Camera       │  Project all bbox centers to shared ground plane
│  Deduplication      │  via pre-computed homography matrix (ArUco calibration).
│  (ESP32 math lib)   │  Merge pairs with Euclidean distance ≤ 30 mm.
│                     │  Output: unique_count per spindle per checkpoint.
└────────┬────────────┘
         │ deduplicated_count, checkpoint_id, spindle_timestamp
         ▼
┌─────────────────────┐
│  FIFO Reconciler    │  On ENTRY event: push count to ring buffer.
│  (fixed ring buffer)│  On EXIT event: pop front of buffer, compare.
│                     │  Result: MATCH (delta=0) or MISMATCH (delta≠0).
└────────┬────────────┘
         │ reconciliation_result
         ▼
┌─────────────────────┐
│  RabbitMQ Publisher │  Publish events to appropriate exchanges.
│  (ESP32 AMQP client)│  All messages are JSON, schema-versioned.
└─────────────────────┘
```

### 4.2 Roboflow Model Configuration

- **Model source:** Roboflow hosted inference API (project endpoint).
- **Architecture versions:** YOLO (primary), RT-DETR (evaluated alternative).
- **Admin can switch model versions** via the Next.js admin panel, which updates the `model_version` field in the `detection_model` table. The ESP32 module fetches the active model ID from Supabase on boot and includes it in every Roboflow API request (`?model={version}`).
- **API endpoint format:**
  ```
  POST https://detect.roboflow.com/{project}/{version}
  Content-Type: application/x-www-form-urlencoded

  api_key={ROBOFLOW_API_KEY}&image={base64_encoded_frame}
  ```
- **Metrics tracked per inference:** mAP@0.5, response latency (ms), confidence distribution, ESP32 heap usage.

### 4.3 Camera Video Stream Architecture

The **Live Cameras** page in the Next.js dashboard (see Screen 5) displays real-time MJPEG feeds from each of the four cameras. The current `ARCHITECTURE.md` does **not** explicitly define this video stream path; the diagram and data-flow sections only describe detection-event messages travelling to the dashboard. The live video path is defined below.

#### Stream Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ESP32 EDGE COMPUTE                          │
│                                                                     │
│   Cam-EN-T  ──▶  ┌──────────────┐                                 │
│   Cam-EN-S  ──▶  │ frame-capture│  ┌─────────────────────────┐    │
│                  │   (task)     │  │   MJPEG Stream Server   │    │
│   Cam-EX-T  ──▶  │   JPEG       │──│   (ESP32 HTTP server)   │    │
│   Cam-EX-S  ──▶  │   encode     │  │                         │    │
│                  └──────────────┘  │  /stream/cam-01  (MJPEG)│    │
│                                    │  /stream/cam-02  (MJPEG)│    │
│                                    │  /stream/cam-03  (MJPEG)│    │
│                                    │  /stream/cam-04  (MJPEG)│    │
│                                    └──────────┬──────────────┘    │
└─────────────────────────────────────────────────┼───────────────────┘
                                                  │ Wi-Fi (LAN / VPN)
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Next.js Dashboard                               │
│                                                                     │
│   ┌─────────────────┐  ┌─────────────────┐                         │
│   │  /app/cameras   │  │  CameraTile     │                         │
│   │    /page.tsx    │  │  component      │                         │
│   │                 │  │                 │                         │
│   │  <img src=      │  │  • <img> tag    │                         │
│   │   "http://esp32 │  │    pointing to  │                         │
│   │    /stream/..."│  │    MJPEG endpoint│                        │
│   │  />             │  │  • FPS overlay  │                         │
│   │                 │  │  • Status badge │                         │
│   └─────────────────┘  └─────────────────┘                         │
│                                                                     │
│   • Browser opens a long-lived HTTP connection to each endpoint.   │
│   • ESP32 serves multipart/x-mixed-replace frames at ~15-30 fps.   │
│   • Dashboard tile reads frame timestamps to compute live FPS.     │
│   • If connection drops > 5 s, tile shows "OFFLINE" badge.         │
└─────────────────────────────────────────────────────────────────────┘
```

#### Why MJPEG over WebRTC / HLS

| Approach | Latency | ESP32 Load | Browser Support | Decision |
|----------|---------|------------|-----------------|----------|
| MJPEG over HTTP | ~100-200 ms | Low (no encoding) | Native `<img>` | ✅ Chosen |
| WebRTC | ~50 ms | High (requires libdatachannel) | Good | ❌ Too heavy for ESP32 |
| HLS | ~2-10 s | Low | Native `<video>` | ❌ Too slow for live monitoring |
| WebSocket + JPEG | ~150 ms | Medium | Custom decoder | ❌ More complex, no benefit |

#### Stream Endpoint Contract

Each ESP32 exposes four HTTP endpoints (one per camera):

```
GET http://{esp32-host}/stream/{camera_id}

Response:
  Content-Type: multipart/x-mixed-replace; boundary=frame

  --frame
  Content-Type: image/jpeg
  X-Timestamp: 2026-05-09T08:32:11.042Z
  X-Camera-FPS: 29.8

  <binary JPEG data>
  --frame
  ...
```

#### Security

- ESP32 and Next.js dashboard run on the same factory LAN / VPN.
- No authentication on the MJPEG endpoint (firewall-isolated).
- If external access is required, a reverse-proxy (e.g., Nginx with `auth_request`) can gate the stream.

#### Failure Mode

- **Camera disconnect:** `frame-capture` task stops feeding the MJPEG ring buffer; the HTTP server re-sends the last valid frame with `X-Camera-FPS: 0` for 5 s, then closes the connection.
- **ESP32 reboot:** Stream connections drop; dashboard tile retries with exponential backoff; health queue publishes `offline` status to RabbitMQ.
- **Network partition:** Dashboard shows cached last frame + "Connection Lost" overlay; detection events are still generated locally by the ESP32 and queued for RabbitMQ reconnection.

---

## 5. Message Broker Layer (RabbitMQ)

### 5.1 Exchange Topology

```
PRODUCER (Edge Node)
        │
        ├──▶ exchange: detection.events  (type: direct)
        │         │
        │         ├── routing key: entry.count  ──▶ queue: spindle.entry
        │         └── routing key: exit.count   ──▶ queue: spindle.exit
        │
        └──▶ exchange: health  (type: topic)
                  │
                  ├── routing key: camera.#     ──▶ queue: health.camera
                  ├── routing key: model.#      ──▶ queue: health.model
                  └── routing key: esp32.#      ──▶ queue: health.esp32
```

### 5.2 Message Schemas

#### detection.events — entry.count / exit.count
```json
{
  "schema_version": "1.0",
  "event_type": "spindle_detection",
  "checkpoint": "entry | exit",
  "spindle_pass_id": "uuid-v4",
  "session_id": "uuid-v4",
  "camera_ids": ["CAM-01", "CAM-02"],
  "deduplicated_count": 26,
  "raw_counts": { "CAM-01": 24, "CAM-02": 25 },
  "confidence_avg": 0.93,
  "inference_latency_ms": 142,
  "timestamp": "2026-05-09T08:32:11.042Z"
}
```

#### health — camera
```json
{
  "schema_version": "1.0",
  "event_type": "camera_health",
  "camera_id": "CAM-01",
  "status": "online | offline | error",
  "fps_actual": 29.8,
  "timestamp": "2026-05-09T08:32:00.000Z"
}
```

### 5.3 Consumer Map

| Queue | Consumer Service | Action |
|-------|-----------------|--------|
| `spindle.entry` | Persistence Worker | INSERT into `spindle_pass` (entry fields) |
| `spindle.exit` | Persistence Worker | UPDATE `spindle_pass` (exit fields + status) |
| `health.camera` | Persistence Worker + Grafana exporter | UPDATE `camera` status; expose Prometheus metric |
| `health.model` | Persistence Worker | Log model health metric |
| `health.esp32` | Grafana exporter | Expose Prometheus metric |

---

## 6. Storage Layer (Supabase PostgreSQL)

### 6.1 Connection Architecture

```
Edge Persistence Worker  ──HTTPS/REST──▶  Supabase API Gateway
                                                   │
Next.js Dashboard        ──Supabase JS──▶  Supabase API Gateway
                                                   │
                                          ┌────────┴────────┐
                                          │  PostgreSQL      │
                                          │  (Supabase host) │
                                          └────────┬────────┘
                                                   │
                                          Supabase Realtime
                                          (WebSocket pub/sub)
                                                   │
                                          Next.js Dashboard
                                          (live count updates)
```

- **Row-Level Security (RLS)** is enabled on all tables.
- **Supabase Realtime** is used for the live dashboard feed: the dashboard subscribes to the `spindle_pass` table and receives push updates within ≤ 2 s of any write.
- **Supabase Storage** holds exported shift reports (PDF/CSV).

### 6.2 Entity Relationship Diagram

```
PRODUCTION_SESSION
─────────────────
session_id       PK  uuid
shift_label          varchar(50)
start_time           timestamptz
end_time             timestamptz   nullable
total_spindles       int           default 0
total_matched        int           default 0
total_mismatched     int           default 0
operator_id      FK  → USER.user_id
        │
        │ 1:N
        ▼
SPINDLE_PASS
─────────────────
spindle_pass_id  PK  uuid
session_id       FK  → PRODUCTION_SESSION
entry_count          int
exit_count           int           nullable
entry_time           timestamptz
exit_time            timestamptz   nullable
status               varchar(20)   -- in_progress | matched | mismatched
mismatch_delta       int           nullable
        │
        │ 1:N
        ▼
DETECTION_EVENT
─────────────────────────────────────
event_id      PK  uuid
camera_id     FK  → CAMERA
model_id      FK  → DETECTION_MODEL
spindle_pass_id FK → SPINDLE_PASS
frame_timestamp   timestamptz
raw_count         int
confidence_avg    float
processing_time_ms int

CAMERA                              DETECTION_MODEL
─────────────────────               ─────────────────────
camera_id     PK  int               model_id    PK  int
name              varchar(50)       model_name      varchar(100)
location          varchar(100)      version         varchar(20)
position_type     varchar(10) -- entry|exit   architecture   varchar(20) -- YOLO11|RT-DETR
status            varchar(20)       accuracy        float
resolution        varchar(20)       mlflow_run_id   varchar(100)
created_at        timestamptz       is_active       boolean  default false
                                    deployed_at     timestamptz

USER
─────────────────────
user_id       PK  int
username          varchar(50)  UNIQUE
full_name         varchar(100)
role              varchar(20)  -- operator | supervisor | admin
email             varchar(100) UNIQUE
is_active         boolean
created_at        timestamptz
```

### 6.3 Key Indexes

```sql
-- Fast FIFO reconciliation lookup
CREATE INDEX idx_spindle_pass_session_status
    ON spindle_pass (session_id, status, entry_time);

-- Detection event temporal query
CREATE INDEX idx_detection_event_spindle_time
    ON detection_event (spindle_pass_id, frame_timestamp);
```

---

## 7. Application Layer (Next.js Dashboard)

### 7.1 Why Supabase Client Directly (No ORM)

The Supabase JS client (`@supabase/supabase-js`) already provides:

- **Auto-generated TypeScript types** from the DB schema via `supabase gen types typescript`, giving full type safety without a separate ORM schema file to maintain.
- **Built-in Realtime** — subscribing to table changes is a one-liner on the client.
- **RLS-aware queries** — every query automatically runs under the authenticated user's RLS policy when using the anon/user JWT, so access control is enforced at the DB level rather than the application layer.
- **Direct PostgREST calls** — Supabase exposes a REST API over PostgreSQL natively; adding an ORM on top is a redundant abstraction that adds bundle size and an extra schema to keep in sync.

The pattern used throughout the Next.js routes is:

```ts
// Server Component or Route Handler — uses service role key (bypasses RLS for writes)
import { createClient } from '@/lib/supabase/server'

const supabase = createClient()   // reads SUPABASE_URL + SUPABASE_SERVICE_KEY from env
const { data, error } = await supabase
  .from('spindle_pass')
  .select('*')
  .eq('session_id', sessionId)
  .order('entry_time', { ascending: false })

// Client Component — uses anon key, queries run under user's RLS policy
import { createBrowserClient } from '@/lib/supabase/client'
```

### 7.2 Authentication — better-auth

`better-auth` replaces Supabase Auth entirely for the following reasons:

- **Custom role model** — Supabase Auth's `user_metadata` approach for roles is fragile and not enforced at the DB level. `better-auth` lets us define `operator | supervisor | admin` as a first-class concept in session tokens, verifiable in Next.js middleware without a DB round-trip.
- **App Router native** — `better-auth` ships with a Next.js plugin that integrates cleanly with `middleware.ts`, Server Components, and Route Handlers using the standard `auth()` helper, with no adapter shim needed.
- **Session stored in our own DB** — sessions land in the `session` and `account` tables in our Supabase PostgreSQL instance, so they are auditable alongside all other operational data.
- **No vendor lock-in on auth** — if Supabase Auth pricing or policy changes, our auth layer is unaffected.

#### better-auth Schema (added to Supabase PostgreSQL)

```sql
-- Managed by better-auth migrations; do not edit manually
CREATE TABLE "user" (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    image         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Application-specific columns
    role          TEXT NOT NULL DEFAULT 'operator'
                  CHECK (role IN ('operator','supervisor','admin')),
    is_active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE session (
    id            TEXT PRIMARY KEY,
    expires_at    TIMESTAMPTZ NOT NULL,
    token         TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address    TEXT,
    user_agent    TEXT,
    user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE account (
    id                    TEXT PRIMARY KEY,
    account_id            TEXT NOT NULL,
    provider_id           TEXT NOT NULL,
    user_id               TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    access_token          TEXT,
    refresh_token         TEXT,
    id_token              TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope                 TEXT,
    password              TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification (
    id         TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### better-auth Configuration (`lib/auth.ts`)

```ts
import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { createClient } from '@supabase/supabase-js'

export const auth = betterAuth({
  database: {
    // Points better-auth at the same Supabase PostgreSQL instance
    provider: 'postgresql',
    url: process.env.DATABASE_URL,   // direct connection string, not Supabase REST
  },
  plugins: [nextCookies()],
  session: {
    expiresIn: 60 * 60 * 8,         // 8-hour shift session
    updateAge: 60 * 60,              // refresh token every 1 hour
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // internal factory system — no email flow needed
  },
  user: {
    additionalFields: {
      role: { type: 'string', required: true, defaultValue: 'operator' },
      is_active: { type: 'boolean', required: true, defaultValue: true },
    },
  },
})
```

#### Middleware (`middleware.ts`)

```ts
import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const ROLE_ROUTES: Record<string, string[]> = {
  '/reports':          ['supervisor', 'admin'],
  '/settings':         ['admin'],
  '/settings/models':  ['admin'],
  '/settings/users':   ['admin'],
  '/settings/devices': ['admin'],
}

export async function middleware(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers })

  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const path = request.nextUrl.pathname
  const requiredRoles = Object.entries(ROLE_ROUTES).find(([route]) =>
    path.startsWith(route)
  )?.[1]

  if (requiredRoles && !requiredRoles.includes(session.user.role)) {
    return NextResponse.redirect(new URL('/unauthorized', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!login|api/auth|_next|favicon.ico).*)'],
}
```

### 7.3 Service Architecture

```
Browser Client
      │
      │ HTTPS
      ▼
Next.js (App Router)
      │
      ├── middleware.ts                   — better-auth session check + role guard
      │
      ├── /app/(auth)/login/page.tsx      — Sign-in form (better-auth client)
      ├── /app/(dashboard)/page.tsx       — Live production counts
      ├── /app/cameras/page.tsx           — Live camera feed status
      ├── /app/reports/page.tsx           — Historical reports + export  [supervisor+]
      ├── /app/devices/page.tsx           — Camera & ESP32 device health
      ├── /app/settings/page.tsx          — Thresholds, notifications    [admin]
      ├── /app/settings/models/page.tsx   — Roboflow model version config [admin]
      ├── /app/settings/users/page.tsx    — User management              [admin]
      │
      ├── /api/auth/[...all]/route.ts     — better-auth handler (login, logout, session)
      ├── /api/sessions/route.ts          — CRUD production sessions
      ├── /api/spindles/route.ts          — Spindle pass read
      ├── /api/models/route.ts            — Roboflow model list          [admin]
      ├── /api/models/[id]/deploy/route.ts— Deploy model version         [admin]
      ├── /api/reports/export/route.ts    — Generate PDF/CSV export      [supervisor+]
      ├── /api/users/route.ts             — List/create users            [admin]
      ├── /api/users/[id]/route.ts        — Update/deactivate user       [admin]
      │
      ├── Supabase JS client              — Direct DB reads + Realtime subscription
      └── OpenTelemetry SDK              — Traces → Tempo
```

No ORM. No extra abstraction. The Supabase client talks directly to PostgreSQL via the PostgREST layer, and better-auth owns the session — each doing exactly one job.

### 7.4 Role-Based Access Control

| Feature | Operator | Supervisor | Admin |
|---------|----------|------------|-------|
| View live dashboard | ✅ | ✅ | ✅ |
| View live camera feeds | ✅ | ✅ | ✅ |
| Generate reports | ❌ | ✅ | ✅ |
| Export audit logs | ❌ | ✅ | ✅ |
| Manage detection models | ❌ | ❌ | ✅ |
| Configure camera settings | ❌ | ❌ | ✅ |
| Manage users | ❌ | ❌ | ✅ |

### 7.5 Realtime Update Path

```
Supabase DB write (spindle_pass)
        │
        ▼
Supabase Realtime WebSocket broadcast
        │
        ▼
Next.js client — useRealtime() hook
        │
        ▼
React state update → UI re-render (< 2 s SLA)
```

---

## 8. Observability Stack

### 8.1 Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                      OBSERVABILITY STACK                             │
│                                                                      │
│   ┌─────────────┐   scrape    ┌────────────────┐                    │
│   │ Prometheus  │◀────────────│ Edge Exporter  │ (inference metrics) │
│   │ (metrics)   │◀────────────│ Node Exporter  │ (hardware metrics)  │
│   │             │◀────────────│ RabbitMQ Exporter│ (queue depths)    │
│   │             │◀────────────│ Next.js /metrics │ (app metrics)     │
│   └──────┬──────┘             └────────────────┘                    │
│          │ query                                                      │
│          ▼                                                            │
│   ┌─────────────┐                                                    │
│   │  Grafana    │ ◀── datasource: Loki (logs)                        │
│   │ (dashboards)│ ◀── datasource: Tempo (traces)                     │
│   │             │ ◀── datasource: Prometheus (metrics)               │
│   └─────────────┘                                                    │
│                                                                      │
│   ┌─────────────┐    push     ┌────────────────────────────────────┐ │
│   │    Loki     │◀────────────│ Promtail / OTel Collector          │ │
│   │   (logs)    │             │  - Edge inference logs             │ │
│   └─────────────┘             │  - RabbitMQ consumer logs          │ │
│                               │  - Next.js application logs        │ │
│   ┌─────────────┐    push     │  - Persistence worker logs         │ │
│   │    Tempo    │◀────────────│ OpenTelemetry SDK (OTLP traces)    │ │
│   │  (traces)   │             └────────────────────────────────────┘ │
│   └─────────────┘                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Metrics Catalogue

| Metric Name | Type | Source | Description |
|-------------|------|--------|-------------|
| `spraycount_inference_latency_ms` | Histogram | Edge | Per-frame inference time |
| `spraycount_detection_confidence_avg` | Gauge | Edge | Average confidence per spindle pass |
| `spraycount_spindle_total` | Counter | Edge | Total spindle passes processed |
| `spraycount_mismatch_total` | Counter | Edge | Total mismatch events |
| `spraycount_fifo_queue_depth` | Gauge | Edge | Pending entries in FIFO reconciler |
| `spraycount_camera_fps` | Gauge | Edge | Actual FPS per camera |
| `spraycount_camera_status` | Gauge (0/1) | Edge | Camera online/offline state |
| `rabbitmq_queue_messages_ready` | Gauge | RabbitMQ Exporter | Queue depth per queue |
| `rabbitmq_queue_messages_unacked` | Gauge | RabbitMQ Exporter | Unacknowledged messages |
| `spraycount_db_write_latency_ms` | Histogram | Persistence Worker | DB write duration |
| `spraycount_dashboard_active_users` | Gauge | Next.js | Connected dashboard sessions |
| `process_cpu_seconds_total` | Counter | Node Exporter | Edge node CPU usage |
| `process_resident_memory_bytes` | Gauge | Node Exporter | Edge node RAM usage |

### 8.3 Grafana Dashboard Panels

**Production Overview Dashboard**
- Live spindle count (entry vs. exit) — time-series
- Mismatch rate (%) — gauge
- Inference latency P50 / P95 / P99 — histogram panel
- Camera status grid (4 cameras, green/red) — table panel

**System Health Dashboard**
- Edge CPU & RAM utilization — time-series
- RabbitMQ queue depths per queue — time-series
- DB write latency — histogram
- FIFO queue depth over time — time-series
- ESP32 trigger pulse rate — time-series

### 8.4 Alerting Rules (Prometheus AlertManager)

```yaml
groups:
  - name: spraycount.critical
    rules:
      - alert: CameraOffline
        expr: spraycount_camera_status == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Camera {{ $labels.camera_id }} is offline"

      - alert: InferenceLatencyHigh
        expr: histogram_quantile(0.95, spraycount_inference_latency_ms) > 450
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "P95 inference latency approaching 500ms limit"

      - alert: FIFOQueueDepthHigh
        expr: spraycount_fifo_queue_depth > 20
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "FIFO reconciliation queue is building up"
```

---

## 9. Data Flow — Normal Operation

```
1. Spindle approaches Checkpoint A (Entry)
        │
2. ESP32 detects spindle via proximity sensor → captures frame
        │
3. Frame Capture service acquires synchronized frames from CAM-01 and CAM-02
        │
4. Preprocessing: resize, normalize
        │
5. AI Inference: YOLO11 / RT-DETR detects car parts on spindle hooks
   ├── Confidence < 0.85 → discarded
   └── Confidence ≥ 0.85 → kept
        │
6. Cross-Camera Deduplication:
   ├── Project CAM-01 detections to ground plane via H₁ (homography)
   ├── Project CAM-02 detections to ground plane via H₂ (homography)
   └── Merge pairs with Euclidean distance ≤ 30 mm → unique_count
        │
7. FIFO Reconciler: push(unique_count) to deque
        │
8. RabbitMQ Publisher: publish to detection.events / entry.count
        │
9. Persistence Worker: INSERT spindle_pass (entry_count, entry_time, status='in_progress')
        │
10. Spindle travels through spray paint machine
        │
11. Spindle exits at Checkpoint B (Exit) — same flow steps 2-7 for CAM-03 / CAM-04
        │
12. FIFO Reconciler: exit_count = pop() from deque front
    └── Compare: entry_count == exit_count?
        ├── YES → status = 'matched', delta = 0
        └── NO  → status = 'mismatched', delta = |entry - exit|
        │
13. RabbitMQ Publisher: publish to detection.events / exit.count
        │
14. Persistence Worker: UPDATE spindle_pass (exit_count, exit_time, status, mismatch_delta)
        │
15. Supabase Realtime: broadcasts row change to subscribed Next.js clients
        │
16. Dashboard updates live count within ≤ 2 s
```

> **Note on mismatch notifications:** When a mismatch is detected, the system records it in `spindle_pass` (status = `mismatched`) and increments `total_mismatched` on the session. No separate alert management service is required. Push notifications (e.g., browser push or factory-floor display triggers) can be emitted directly from the Next.js dashboard via Supabase Realtime subscriptions if desired.

---

## 10. Database Schema

### Full DDL

```sql
-- Users
CREATE TABLE "user" (
    user_id     SERIAL PRIMARY KEY,
    username    VARCHAR(50)  NOT NULL UNIQUE,
    full_name   VARCHAR(100) NOT NULL,
    role        VARCHAR(20)  NOT NULL CHECK (role IN ('operator','supervisor','admin')),
    email       VARCHAR(100) NOT NULL UNIQUE,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Cameras
CREATE TABLE camera (
    camera_id     SERIAL PRIMARY KEY,
    name          VARCHAR(50)  NOT NULL,
    location      VARCHAR(100),
    position_type VARCHAR(10)  NOT NULL CHECK (position_type IN ('entry','exit')),
    status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive','error')),
    resolution    VARCHAR(20),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Detection models
CREATE TABLE detection_model (
    model_id      SERIAL PRIMARY KEY,
    model_name    VARCHAR(100) NOT NULL,
    version       VARCHAR(20)  NOT NULL,
    architecture  VARCHAR(20)  NOT NULL CHECK (architecture IN ('YOLO11','RT-DETR')),
    accuracy      FLOAT,
    mlflow_run_id VARCHAR(100),
    is_active     BOOLEAN      NOT NULL DEFAULT false,
    deployed_at   TIMESTAMPTZ
);

-- Production sessions
CREATE TABLE production_session (
    session_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_label      VARCHAR(50),
    start_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
    end_time         TIMESTAMPTZ,
    total_spindles   INT         NOT NULL DEFAULT 0,
    total_matched    INT         NOT NULL DEFAULT 0,
    total_mismatched INT         NOT NULL DEFAULT 0,
    operator_id      INT         REFERENCES "user"(user_id)
);

-- Spindle passes
CREATE TABLE spindle_pass (
    spindle_pass_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID        NOT NULL REFERENCES production_session(session_id),
    entry_count     INT         NOT NULL,
    exit_count      INT,
    entry_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_time       TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                                CHECK (status IN ('in_progress','matched','mismatched')),
    mismatch_delta  INT
);

-- Detection events (per-frame records)
CREATE TABLE detection_event (
    event_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id          INT         NOT NULL REFERENCES camera(camera_id),
    model_id           INT         NOT NULL REFERENCES detection_model(model_id),
    spindle_pass_id    UUID        NOT NULL REFERENCES spindle_pass(spindle_pass_id),
    frame_timestamp    TIMESTAMPTZ NOT NULL,
    raw_count          INT         NOT NULL,
    confidence_avg     FLOAT,
    processing_time_ms INT
);

-- Indexes
CREATE INDEX idx_spindle_pass_session_status ON spindle_pass (session_id, status, entry_time);
CREATE INDEX idx_detection_event_spindle_time ON detection_event (spindle_pass_id, frame_timestamp);

-- Enable Supabase Realtime on key tables
ALTER PUBLICATION supabase_realtime ADD TABLE spindle_pass;
ALTER PUBLICATION supabase_realtime ADD TABLE camera;
```

---

## 11. API Contract

### Edge → Supabase (via Persistence Worker)

All calls use Supabase REST API with `service_role` key (server-side only, never exposed to browser).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/rest/v1/spindle_pass` | Insert entry record |
| PATCH | `/rest/v1/spindle_pass?spindle_pass_id=eq.{id}` | Update with exit count + status |
| PATCH | `/rest/v1/camera?camera_id=eq.{id}` | Update camera status |
| POST | `/rest/v1/detection_event` | Insert per-frame detection |

### Next.js API Routes (browser clients)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/sessions` | Any role | List production sessions |
| POST | `/api/sessions` | Operator+ | Start new session |
| PATCH | `/api/sessions/{id}` | Operator+ | End session |
| GET | `/api/spindles?session_id={id}` | Any role | Spindle passes for session |
| GET | `/api/reports?from={date}&to={date}` | Supervisor+ | Report data |
| GET | `/api/reports/export` | Supervisor+ | Download PDF/CSV |
| GET | `/api/models` | Admin | List Roboflow model versions |
| POST | `/api/models/{id}/deploy` | Admin | Deploy a model version |
| GET | `/api/devices` | Any role | Camera + ESP32 health |
| PUT | `/api/devices/{id}` | Admin | Update device config |

### Roboflow REST API (Admin → Cloud)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `https://api.roboflow.com/{workspace}/{project}` | List model versions |
| GET | `https://api.roboflow.com/{workspace}/{project}/{version}` | Get version metrics |
| POST | `https://api.roboflow.com/{workspace}/{project}/{version}/deploy` | Deploy version to active inference endpoint |

---

## 12. RabbitMQ Exchange & Queue Topology

```
Virtual Host: spraycount

Exchanges:
  - detection.events   type=direct    durable=true
  - health             type=topic     durable=true
  - dlx.spraycount     type=direct    durable=true  (dead-letter exchange)

Queues:
  Name                  Exchange          Routing Key        DLX                 TTL
  ──────────────────────────────────────────────────────────────────────────────────
   spindle.entry         detection.events  entry.count        dlx.spraycount      —
   spindle.exit          detection.events  exit.count         dlx.spraycount      —
   health.camera         health            camera.#           dlx.spraycount      30 s
  health.model          health            model.#            dlx.spraycount      30 s
  health.esp32          health            esp32.#            dlx.spraycount      30 s
  dlq.spraycount        dlx.spraycount    #                  —                   —
```

- **DLQ (dead-letter queue):** All failed/expired messages land in `dlq.spraycount` for inspection and replay.
- **Prefetch:** Consumer prefetch = 1 for the persistence worker to guarantee ordered processing.
- **Message persistence:** All messages published with `delivery_mode=2` (persistent to disk).

---

## 13. Deployment Topology

### 13.1 Edge Node (On-Premises)

```
┌─────────────────────────────────────────────────────┐
│              Edge Node (Docker Compose)              │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  frame-capture   │  │    ai-inference           │ │
│  │  (Python/OpenCV) │  │    (Roboflow API client)  │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  dedup-service   │  │    fifo-reconciler        │ │
│  │  (Python/NumPy)  │  │    (Python/deque)         │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  rabbitmq-pub    │  │    mlflow-server          │ │
│  │  (ESP32 AMQP)    │  │    (Roboflow cloud)       │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  otel-collector  │  │    node-exporter          │ │
│  └──────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
          │ AMQP (TLS)         │ OTLP, Prom scrape
          ▼                    ▼
```

### 13.2 VPS / Cloud (Remote Server)

```
┌─────────────────────────────────────────────────────┐
│              VPS (Docker Compose)                   │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  RabbitMQ        │  │  Persistence Worker       │ │
│  │  (AMQP broker)   │  │  (Python consumer)        │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐                               │
│  │  Next.js         │                               │
│  │  (Dashboard)     │                               │
│  └──────────────────┘                               │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  Prometheus      │  │  Grafana                  │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  Loki            │  │  Tempo                    │ │
│  └──────────────────┘  └──────────────────────────┘ │
│  ┌──────────────────┐                               │
│  │  Promtail        │                               │
│  └──────────────────┘                               │
└─────────────────────────────────────────────────────┘
          │ Supabase REST / Realtime (HTTPS)
          ▼
┌─────────────────────────────────────────────────────┐
│          Supabase (Managed Cloud)                   │
│  PostgreSQL + Realtime + RLS + Storage           │
└─────────────────────────────────────────────────────┘
```

### 13.3 docker-compose.yml Structure (VPS)

```yaml
services:
  rabbitmq:
    image: rabbitmq:management
    ports: ["5672:5672", "15672:15672"]
    environment:
      RABBITMQ_DEFAULT_VHOST: spraycount

  persistence-worker:
    build: ./services/persistence
    depends_on: [rabbitmq]
    environment:
      RABBITMQ_URL: amqp://rabbitmq:5672/spraycount
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}

  nextjs:
    build: ./dashboard
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_SUPABASE_URL: ${SUPABASE_URL}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      RABBITMQ_URL: amqp://rabbitmq:5672/spraycount

  prometheus:
    image: prom/prometheus
    volumes: ["./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml"]
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana
    ports: ["3001:3000"]
    volumes: ["./monitoring/grafana:/etc/grafana/provisioning"]

  loki:
    image: grafana/loki
    ports: ["3100:3100"]

  tempo:
    image: grafana/tempo
    ports: ["3200:3200", "4317:4317"]

  promtail:
    image: grafana/promtail
    volumes:
      - /var/log:/var/log
      - ./monitoring/promtail.yml:/etc/promtail/config.yml
```

---

## 14. Non-Functional Requirements Mapping

| NFR | Target | Implementation |
|-----|--------|----------------|
| Latency < 500 ms | Pipeline: capture + inference + dedup + publish | FIFO deque is O(1); homography transform pre-computed offline; AMQP publish is async |
| Accuracy ≥ 95 % | mAP@0.5 on test set | Confidence threshold 0.85; dual-camera dedup; ArUco calibration; YOLO / RT-DETR evaluation |
| Dashboard refresh ≤ 2 s | Supabase Realtime WebSocket | Row-level pub/sub on `spindle_pass` table |
| Camera fault tolerance | Graceful degradation | Health queue monitors each camera; inference continues on remaining streams; dashboard shows OFFLINE badge |
| Availability ≥ 99 % | No single point of failure | RabbitMQ persisted messages survive restarts; Persistence Worker auto-reconnects; DLQ prevents message loss |
| Auditability | Full traceable history | Every detection event and reconciliation result stored with timestamp in PostgreSQL; Loki retains all logs |
| Model hot-swap | Zero-downtime model update | Roboflow API version switch updates `detection_model` table; ESP32 fetches new version ID on next inference cycle without reboot |

---

## 15. Component & Technology Reference

| Component | Version | Role |
|-----------|---------|------|
| Ultralytics YOLO | latest | Primary object detection model |
| RT-DETR | — | Alternative detection architecture (evaluated) |
| Roboflow Inference API | — | Cloud-based object detection inference (YOLO / RT-DETR) |
| OpenCV (cv2) | latest | Frame capture, preprocessing, homography, ArUco |
| NumPy | latest | Array ops, distance calculations |
| Roboflow API | — | Model registry, versioning, deployment management |
| ESP32 AMQP client | — | Lightweight AMQP publisher for RabbitMQ |
| RabbitMQ | latest | Message broker (AMQP 0-9-1) |
| Supabase | — | Managed PostgreSQL + Realtime + RLS |
| psycopg2 | latest | Direct PostgreSQL adapter (persistence worker) |
| FastAPI | latest | Edge-local REST API (inference status endpoint) |
| Next.js | latest | Web dashboard (App Router) |
| better-auth | latest | Authentication, session management, role enforcement |
| @supabase/supabase-js | latest | Direct Supabase client — DB queries + Realtime (no ORM) |
| Prometheus | latest | Metrics scraping and storage |
| Grafana | latest | Dashboard visualization and alerting UI |
| Loki | latest | Log aggregation |
| Tempo | latest | Distributed tracing (OTLP) |
| Promtail | latest | Log shipping agent (Loki) |
| OpenTelemetry | latest | Tracing SDK (Python + Node.js) |
| Docker / Compose | — | Service containerization and deployment |
| ESP32 | — | Frame trigger synchronization via GPIO pulse |
| USB 3.0 Cameras | 1080p / 30fps | 4 units, IP65 enclosure, hardware video input |
| ArUco Markers | OpenCV aruco module | Spindle rotation angle estimation + calibration |
| NTP | — | Time synchronization across ESP32 modules and VPS |
| Python collections.deque | stdlib | FIFO queue for spindle reconciliation |
| JSON (ECMA-404) | — | All AMQP message payloads and API request/response |
| REST + HTTPS | — | All inter-service communication outside edge LAN |
| COCO format | — | Detection model output bounding box format |

---
