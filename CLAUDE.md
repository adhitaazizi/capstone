@AGENTS.md

# SprayCount — Project Context for Claude

## What this project is

SprayCount is an industrial edge-AI system that counts Hot Wheels toys on rotating spindles at a spray painting station. Two cameras observe each spindle in sequence; comparing their counts detects toys lost or miscounted between stations. Results are displayed on a Next.js dashboard.

**Team:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**University:** President University, Faculty of Computer Science (Capstone Design)

---

## Architecture

```
Browser (camera operator, /cameras)      ┌──────────────────────────────┐
  • lib/webrtc/publisher.ts:             │ Next.js (port 3000)          │
  •   getUserMedia → WebRTC              │                              │
  • POST /api/cameras/register ─────────►│ • owns ALL sampling logic    │
    (session-authed, role: source)       │ • FIFO cross-camera pairing  │
     │                                   │ • writes spindle_pass +      │
     ▼ WebRTC (one track per camera)     │   detection_event            │
Cloudflare Realtime                      └──────────────────────────────┘
     │                                       ▲   │            ▲
     ▼ (raw tracks)                          │   │            │
GPU inference worker (services/inference/)   │   │            │
  • Subscribes to raw tracks                 │   │            │
  • Runs RF-DETR — INFERENCE ONLY            │   │            │
  • GET  /api/inference/source ──────────────┘◄──┘            │
  • POST /api/inference/detections ───────────┘               │
  • POST /api/inference/register (role: processed)             │
  • Publishes annotated video ──► Cloudflare Realtime         │
                                        │                     │
                                        ▼ (processed tracks)  │
                                  Browser dashboard ──────────┘
                                    • subscribes for video
                                    • polls /api/inference/live
```

**There used to be a Python edge worker (`services/edge/`) that relayed RTSP
cameras to Cloudflare Realtime. It has been removed** — the browser publisher
(`lib/webrtc/publisher.ts` + `hooks/use-publisher.ts` +
`components/camera-publisher-panel.tsx`) now captures from the operator's own
camera devices via `getUserMedia` and publishes directly, in-browser, to
Cloudflare Realtime. This is also why `GET /api/inference/source`'s `appId`
field matters more than before: it is how the GPU worker — which may run on a
completely separate machine (e.g. a RunPod pod) — learns which Cloudflare
application the browser is publishing to, with no RTSP/network-camera
plumbing in between.

> **Known gap:** `lib/webrtc/publisher.ts` calls `POST/DELETE
> /api/cameras/register`, but that route handler does not exist yet
> (`app/api/cameras/register/` is an empty directory). Until it's implemented
> — session-authenticated, validating against `lib/cameras.ts`'s `CAMERAS`
> list, and calling `sessions().register('source', ...)` the same way
> `app/api/inference/register/route.ts` does for `role: "processed"` — no
> source camera session ever reaches the registry, so
> `GET /api/inference/source` will keep 404ing and the GPU worker has nothing
> to discover.

**The division of labour is the most important thing to preserve:** the GPU
inference worker runs inference and emits raw per-frame detections. Next.js
does everything else — spindle-boundary filtering, boundary normalization,
`DETECTION_INTERVAL` windowing, `max()`, the `MAX_HOTWHEELS` plausibility
filter, visit segmentation, FIFO pairing, and persistence. That is what lets
every threshold be tuned by editing `.env` and restarting one container while
the inference worker keeps running.

`capstone_inference.ipynb` and `services/inference/` (its native-Python port,
see `services/inference/README.md`) are two interchangeable ways to run that
same GPU-inference half — same three endpoints, same division of labour. Run
one or the other, not both, per deployment.

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
   Both cameras' `detection_event` rows get the **same `spindle_pass_id`**, and
   the same **`spindleNumber`** — a monotonic counter stamped at the entry
   camera, which is what `/cameras` shows as "Spindle number". The UUID is for
   joining rows; the number is for saying out loud.

Ahead of all four sits a **gate** (`consumers.ts`): stages 1–4 do not run at all
for a camera unless a browser on `/cameras` is currently decoding that camera's
annotated track. See constraint 8 below.

---

## Camera setup

- **2 cameras:** `CAM-01` (entry / upstream) and `CAM-02` (exit / downstream).
  A spindle always reaches CAM-01 before CAM-02 — the FIFO pairing depends on it.
- The canonical camera list — id, display name, location, Cloudflare track
  name — lives in `lib/cameras.ts`, the single source of truth for the
  `/cameras` page, the browser publisher, and (once it exists — see the
  known gap above) `app/api/cameras/register/route.ts`.
- No RTSP/video-file config anymore: the browser publisher captures directly
  from whichever camera device the operator selects via `getUserMedia`.

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
| `lib/inference/consumers.ts` | **The counting gate** — which cameras' annotated streams a browser is decoding right now |
| `app/api/cameras/consume/route.ts` | Session-authed viewer heartbeat from `camera-tile.tsx`; opens/closes the gate |
| `app/api/inference/detections/route.ts` | Colab → aggregator ingest (`x-inference-key`) |
| `app/api/inference/register/route.ts` | Edge worker + Colab session registration / heartbeat |
| `app/api/inference/source/route.ts` | Colab discovers the source session (no manual paste) |
| `app/api/inference/live/route.ts` | Dashboard poll: live counts, recent pairs, health |
| `app/api/cloudflare/signal/route.ts` | Signaling proxy — auth'd, path allow-listed, keeps `CF_APP_SECRET` server-side |
| `app/api/cameras/register/route.ts` | **Not yet implemented** — see the known gap above. Meant to register browser-published source sessions (session-authed, `role: "source"`) |
| `lib/cameras.ts` | Canonical camera list (id, name, location, track name) |
| `lib/webrtc/publisher.ts` | Browser publisher singleton — `getUserMedia` → WebRTC → Cloudflare Realtime |
| `hooks/use-publisher.ts` | Binds the publisher singleton into React via `useSyncExternalStore` |
| `components/camera-publisher-panel.tsx` | UI for selecting camera devices and starting/stopping the publisher |
| `components/camera-tile.tsx` | Annotated stream only — no counts; reconnects with backoff |
| `components/local-camera-grid.tsx` | Grid + the single count surface; polls `/api/inference/live` |
| `capstone_inference.ipynb` | Colab: RF-DETR inference, annotation, `DetectionReporter` |
| `services/inference/*.py` | Native-Python port of the notebook above — same pipeline, env-driven, runs on any CUDA GPU host |
| `supabase/migrations/011_inference_pipeline.sql` | `spindle_pass` reconcile + `detection_event` provenance columns |
| `test/inference/*.test.ts` | `npm test` — covers normalization, windowing, segmentation, FIFO identity |

---

## Docker services

| Service | Port | Notes |
|---------|------|-------|
| `nextjs` | 3000 | Dashboard + the entire sampling pipeline, **and** now the camera publisher (browser-side). **Single replica only** |
| `inference` | — | GPU inference worker (`services/inference/`). Opt-in via `--profile inference`; needs an NVIDIA GPU |
| `auth-postgres` | — | better-auth sessions DB |

There is no edge-worker service anymore — see "Camera setup" above.

---

## Environment variables

### Next.js
| Variable | Default | Notes |
|----------|---------|-------|
| `CF_APP_ID` / `CF_APP_SECRET` | — | Used by the signaling proxy; never sent to the browser |
| `INFERENCE_API_KEY` | — | Shared secret for `/api/inference/*`. Unset ⇒ those routes fail closed (503) |

Everything else — `DETECTION_INTERVAL_MS`, `MAX_HOTWHEELS`, `SPINDLE_BOUNDARY_MARGIN`,
`SPINDLE_MIN_CONFIDENCE`, `HOTWHEELS_MIN_CONFIDENCE`, `SPINDLE_ABSENT_INTERVALS`,
`MAX_VISIT_INTERVALS`, `ENTRY_CAMERA_ID`/`EXIT_CAMERA_ID`, `SPINDLE_ORPHAN_TIMEOUT_MS`,
`QUEUE_MAX_DEPTH`, `INFERENCE_CONFIDENCE`, `INFERENCE_MAX_DETECTIONS`,
`INFERENCE_TARGET_CLASS_NAMES`, `INFERENCE_SHAPE` — is no longer `.env`. These are
non-secret, operator-tunable behavior, so they live in the `system_settings` DB
table instead, editable at `/settings/pipeline`. See
`supabase/migrations/012_system_settings.sql`, `lib/inference/settings-store.ts`
(polls the table, applies changes to the running process), and
`lib/inference/constants.ts`'s module docstring for exactly which of these apply
live vs. only after restarting `nextjs` — the ones snapshotted into the
`AggregatorRegistry`/`SpindleQueue` singletons at construction (interval, visit
segmentation, FIFO config) are **not** safe to change mid-run and require a
restart; the per-call ones (boundary margin, confidence thresholds, RF-DETR
tunables) apply within a few seconds.

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

# After a Next.js change (this is also how you re-tune the pipeline, and how
# you pick up changes to the browser publisher under lib/webrtc/):
docker compose up -d --build nextjs

# Unit tests for the whole sampling pipeline — no cameras, GPU, or Colab needed:
npm test

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
5. **No inference in the browser publisher** — `lib/webrtc/publisher.ts` is
   purely a camera relay (`getUserMedia` → WebRTC), same constraint the old
   Python edge worker had. ML runs either in Colab
   (`capstone_inference.ipynb`) or in `services/inference/`, its native-Python
   port for running on a CUDA GPU host instead — use one or the other.
6. **No counting logic in the inference worker.** Colab (or
   `services/inference/`) emits raw detections only. Every
   threshold lives in `lib/inference/constants.ts` so it can be changed without
   a notebook re-run.
7. **One physical spindle must produce exactly one visit per camera.** This is
   what keeps the FIFO aligned; a spindle that splits into two visits shifts
   every subsequent pairing and produces plausible-looking but wrong counts.
8. **Counting only runs while `/cameras` is watching.** `ingestFrames` drops a
   camera's detections unless `lib/inference/consumers.ts` holds a fresh
   heartbeat for it *and* that heartbeat names the processed session currently
   registered for the camera. `components/camera-tile.tsx` sends the heartbeat
   from its `framesDecoded` watchdog, so the same signal that decides whether a
   picture is shown decides whether rows are written — a tile can never display
   a spinner while counting quietly continues behind it. Two consequences to
   preserve: gating **resets** the camera's aggregator (a visit must never span
   a pause, or constraint 7 breaks), and nothing may gate the tile's *mounting*
   on counts having started — that deadlocks, since the counts cannot start
   until the tile is mounted and decoding.
9. **Class names are matched by name, not index.** The checkpoint exposes
   `['hot-wheels-fd1tsjbuot2qusqjctck', 'hot wheels', 'spindle']` where index 0
   is a Roboflow artifact. See `SPINDLE_CLASSES` / `HOTWHEELS_CLASSES`.
