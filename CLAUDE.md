@AGENTS.md

# SprayCount — Project Context for Claude

## What this project is

SprayCount is an industrial edge-AI system that counts Hot Wheels toys on rotating spindles at a spray painting station. Two cameras observe each spindle in sequence; comparing their counts detects toys lost or miscounted between stations. Results are displayed on a Next.js dashboard.

**Team:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**University:** President University, Faculty of Computer Science (Capstone Design)

---

## Architecture

```
RTSP cameras
     │
     ▼
Edge worker (Python, port 8081)          ┌──────────────────────────────┐
  • Reads frames with FrameCapture       │ Next.js (port 3000)          │
  • Publishes to Cloudflare Realtime     │                              │
  • POST /api/inference/register ───────►│ • owns ALL sampling logic    │
     │                                   │ • FIFO cross-camera pairing  │
     ▼ WebRTC (one track per camera)     │ • writes spindle_pass +      │
Cloudflare Realtime                      │   detection_event            │
     │                                   └──────────────────────────────┘
     ▼ (raw tracks)                          ▲   │            ▲
Colab notebook (capstone_inference.ipynb)    │   │            │
  • Subscribes to raw tracks                 │   │            │
  • Runs RF-DETR — INFERENCE ONLY            │   │            │
  • GET  /api/inference/source ──────────────┘◄──┘            │
  • POST /api/inference/detections ───────────┘               │
  • POST /api/inference/register                              │
  • Publishes annotated video ──► Cloudflare Realtime         │
                                        │                     │
                                        ▼ (processed tracks)  │
                                  Browser dashboard ──────────┘
                                    • subscribes for video
                                    • polls /api/inference/live
```

**The division of labour is the most important thing to preserve:** Colab runs
inference and emits raw per-frame detections. Next.js does everything else —
spindle-boundary filtering, boundary normalization, `DETECTION_INTERVAL`
windowing, `max()`, the `MAX_HOTWHEELS` plausibility filter, visit
segmentation, FIFO pairing, and persistence. That is what lets every threshold
be tuned by editing `.env` and restarting one container while Colab keeps
running.

---

## How counting works

Four stages, each a pure function, in `lib/inference/`:

1. **Boundary** (`boundary.ts`) — per frame, pick the primary spindle box
   (ranked by `confidence × area`), then map each hot-wheels centroid into
   *spindle-relative unit space* where the spindle always spans `[0,1]²`.
   This is why a spindle box that changes size or position between samples
   still yields identical containment decisions.
2. **Interval** (`aggregator.ts`) — over each `DETECTION_INTERVAL_MS` window,
   drop samples above `MAX_HOTWHEELS` as implausible, then take `max()` of what
   remains. Max, because the spindle rotates and only some frames catch it with
   no toy hidden behind the post.
3. **Visit** (`aggregator.ts`) — a *visit* is one contiguous run of
   spindle-present intervals: one physical spindle passing one camera. A
   spindle dwells for several intervals, so the visit, not the interval, is the
   event unit.
4. **Pairing** (`queue.ts`) — a FIFO. The line guarantees ordering (spindles
   never overtake), so the n-th exit visit is necessarily the n-th entry visit.
   Both cameras' `detection_event` rows get the **same `spindle_pass_id`**.

---

## Camera setup

- **2 cameras:** `CAM-01` (entry / upstream) and `CAM-02` (exit / downstream).
  A spindle always reaches CAM-01 before CAM-02 — the FIFO pairing depends on it.
- Dev/demo: looping video files (`pov1.mp4`, `pov2.mov`) via `CAMERA_SOURCES`
- Production: RTSP camera URLs via `CAM_01_SOURCE` / `CAM_02_SOURCE`
- Cloudflare track names: `cam-01`, `cam-02` (via `CF_TRACK_NAMES`)

---

## Key file map

| File | Role |
|------|------|
| `lib/inference/boundary.ts` | Per-frame spindle-relative normalization + containment filter |
| `lib/inference/aggregator.ts` | Interval windowing (`max()`) + presence-gated visit segmentation |
| `lib/inference/queue.ts` | FIFO pairing — assigns one `spindle_pass_id` across both cameras |
| `lib/inference/persistence.ts` | Supabase `PassSink` — writes `spindle_pass` + `detection_event` |
| `lib/inference/pipeline.ts` | `globalThis`-pinned singleton wiring the above |
| `lib/inference/constants.ts` | Every tunable, env-backed |
| `lib/inference/registry.ts` | Cloudflare source/processed session registry + heartbeat staleness |
| `app/api/inference/detections/route.ts` | Colab → aggregator ingest (`x-inference-key`) |
| `app/api/inference/register/route.ts` | Edge worker + Colab session registration / heartbeat |
| `app/api/inference/source/route.ts` | Colab discovers the source session (no manual paste) |
| `app/api/inference/live/route.ts` | Dashboard poll: live counts, recent pairs, health |
| `app/api/cloudflare/signal/route.ts` | Signaling proxy — auth'd, path allow-listed, keeps `CF_APP_SECRET` server-side |
| `components/camera-tile.tsx` | Annotated stream only — no counts; reconnects with backoff |
| `components/local-camera-grid.tsx` | Grid + the single count surface; polls `/api/inference/live` |
| `services/edge/main.py` | `CloudflarePublisher` — WebRTC publish + source registration heartbeat |
| `services/edge/frame_capture.py` | `FrameCapture` — RTSP via PyAV, file via OpenCV, capped at 15 fps |
| `capstone_inference.ipynb` | Colab: RF-DETR inference, annotation, `DetectionReporter` |
| `supabase/migrations/011_inference_pipeline.sql` | `spindle_pass` reconcile + `detection_event` provenance columns |
| `test/inference/*.test.ts` | `npm test` — covers normalization, windowing, segmentation, FIFO identity |

---

## Docker services

| Service | Port | Notes |
|---------|------|-------|
| `nextjs` | 3000 | Dashboard + the entire sampling pipeline. **Single replica only** |
| `edge-worker` | 8081 | WebRTC publisher; `/health` and `/cloudflare_session` are diagnostics only |
| `auth-postgres` | — | better-auth sessions DB |

---

## Environment variables

### Edge worker
| Variable | Default | Notes |
|----------|---------|-------|
| `CAMERA_SOURCES` | `{"CAM-01":"/app/video/pov1.mp4","CAM-02":"/app/video/pov2.mov"}` | JSON map of camera ID → source |
| `CF_APP_ID` / `CF_APP_SECRET` | — | Cloudflare Realtime credentials |
| `CF_TRACK_NAMES` | `{"CAM-01":"cam-01","CAM-02":"cam-02"}` | Track name per camera |
| `TARGET_FPS` | 15 | Frame capture rate |
| `HTTP_PORT` | 8081 | Diagnostics HTTP server |
| `NEXTJS_INTERNAL_URL` | `http://nextjs:3000` | Where to register the source session |
| `INFERENCE_API_KEY` | — | Must match the Next.js value |

### Next.js
| Variable | Default | Notes |
|----------|---------|-------|
| `CF_APP_ID` / `CF_APP_SECRET` | — | Used by the signaling proxy; never sent to the browser |
| `INFERENCE_API_KEY` | — | Shared secret for `/api/inference/*`. Unset ⇒ those routes fail closed (503) |
| `DETECTION_INTERVAL_MS` | 2000 | Sampling window. Must span ≥ one full spindle rotation |
| `MAX_HOTWHEELS` | 8 | Physical spindle capacity. Samples above are **dropped**, not clamped |
| `SPINDLE_BOUNDARY_MARGIN` | 0.15 | Containment tolerance, in spindle-relative units |
| `SPINDLE_MIN_CONFIDENCE` | 0.5 | |
| `HOTWHEELS_MIN_CONFIDENCE` | 0.35 | |
| `SPINDLE_ABSENT_INTERVALS` | 1 | Absent intervals needed to close a visit. Raise if flicker splits visits |
| `MAX_VISIT_INTERVALS` | 15 | Force-closes a latched visit |
| `ENTRY_CAMERA_ID` / `EXIT_CAMERA_ID` | `CAM-01` / `CAM-02` | Direction of travel |
| `SPINDLE_ORPHAN_TIMEOUT_MS` | 300000 | Pending entry with no exit is abandoned |

---

## How Colab sends results back

Colab batches every ~500 ms and POSTs to `/api/inference/detections` with the
`x-inference-key` header. Boxes are **frame-normalized** (0–1), so the server
never needs to know the source resolution:

```json
{
  "cameraId": "CAM-01",
  "frames": [
    {
      "ts": 1738612345120.0,
      "inferenceMs": 41.2,
      "detections": [
        {"cls": "spindle",    "conf": 0.88, "box": [0.11, 0.20, 0.83, 0.94]},
        {"cls": "hot wheels", "conf": 0.91, "box": [0.31, 0.22, 0.44, 0.38]}
      ]
    }
  ]
}
```

No counts, no filtering, no windowing — everything downstream of this is Next.js.

---

## Development workflow

```bash
# Everything:
docker compose up -d --build

# After a Python change in services/edge/:
docker compose up -d --build edge-worker

# After a Next.js change (this is also how you re-tune the pipeline):
docker compose up -d --build nextjs

# Unit tests for the whole sampling pipeline — no cameras, GPU, or Colab needed:
npm test

# Tail edge logs / confirm registration:
docker logs capstone-edge-worker-1 -f
docker logs capstone-edge-worker-1 | grep -E "Cloudflare Realtime|Source session registered"

# Expose Next.js to Colab (URL changes on every restart):
cloudflared tunnel --url http://localhost:3000
```

---

## Critical constraints to remember

1. **Do not add extra `sleep()` in `_frame_reader_loop`** — `_capture_opencv`
   already paces file sources via `_next_frame_time`. A second sleep doubles
   the throttle.
2. **`last_model_frame` is 640×640 BGR numpy** — this is what gets published as
   WebRTC video frames. `last_frame` holds display-resolution JPEG bytes used
   only for health checks.
3. **`CF_APP_SECRET` never reaches the browser** — `/api/cloudflare/signal` is a
   server-side proxy. It requires a session and allow-lists the signaling paths;
   do not relax either, since it forwards a caller-supplied path bearing the secret.
4. **`nextjs` must run as a single replica.** The FIFO pairing queue is
   in-process state pinned to `globalThis`. A second replica gets its own queue
   and silently corrupts every pairing. Scaling out requires moving the pending
   queue into Postgres first.
5. **No local inference** — all ML runs in Colab. The edge worker is purely a
   camera relay. Do not add inference code back there.
6. **No counting logic in the notebook.** Colab emits raw detections only. Every
   threshold lives in `lib/inference/constants.ts` so it can be changed without
   a notebook re-run.
7. **One physical spindle must produce exactly one visit per camera.** This is
   what keeps the FIFO aligned; a spindle that splits into two visits shifts
   every subsequent pairing and produces plausible-looking but wrong counts.
8. **Class names are matched by name, not index.** The checkpoint exposes
   `['hot-wheels-fd1tsjbuot2qusqjctck', 'hot wheels', 'spindle']` where index 0
   is a Roboflow artifact. See `SPINDLE_CLASSES` / `HOTWHEELS_CLASSES`.
