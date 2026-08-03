@AGENTS.md

# SprayCount — Project Context for Claude

## What this project is

SprayCount is an industrial edge-AI system that counts Hot Wheels toys on rotating spindles at a spray painting station. Cameras watch each spindle complete one full rotation; the system counts unique toys and displays results on a Next.js dashboard.

**Team:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**University:** President University, Faculty of Computer Science (Capstone Design)

---

## Architecture

```
RTSP cameras
     │
     ▼
Edge worker (Python, port 8081)
  • Reads frames with FrameCapture
  • Publishes raw camera frames to Cloudflare Realtime via WebRTC (aiortc)
  • HTTP server: POST /colab_result (receive from Colab)
                 GET  /spindle_count (polled by Next.js)
                 GET  /cloudflare_session (polled by Next.js)
     │
     ▼ WebRTC tracks (one per camera)
Cloudflare Realtime (App ID: 08974e44564c2b4da09a97378a557e7f)
     │                         │
     ▼ (raw tracks)            │
Colab notebook                 │
  • Subscribes to raw tracks   │
  • Runs RF-DETR inference     │
  • Publishes annotated video back to Cloudflare Realtime
  • HTTP POST count + detections → edge worker /colab_result
                                   │ (processed tracks)
                                   ▼
                           Next.js dashboard
                             • Subscribes to Cloudflare Realtime
                               WebRTC processed tracks for video
                             • Polls /api/edge/spindle_count
                               for count display
```

---

## Camera setup

- **2 cameras:** `CAM-01` (entry, top view) and `CAM-02` (entry, side view)
- Dev/demo: looping video files (`pov1.mp4`, `pov2.mov`) via `CAMERA_SOURCES` env
- Production: RTSP camera URLs via `CAM_01_SOURCE` / `CAM_02_SOURCE`
- Cloudflare track names: `cam-01`, `cam-02` (configured via `CF_TRACK_NAMES`)

---

## Key file map

| File | Role |
|------|------|
| `services/edge/main.py` | `CloudflarePublisher` — WebRTC publish loop + HTTP result server |
| `services/edge/frame_capture.py` | `FrameCapture` — RTSP via PyAV, file via OpenCV, capped at 15 fps |
| `services/edge/config.py` | `EdgeConfig` — camera sources + Cloudflare credentials |
| `components/camera-tile.tsx` | Subscribes to Cloudflare Realtime WebRTC processed track, shows video |
| `components/local-camera-grid.tsx` | Camera grid; polls `/api/edge/spindle_count` and `/api/edge/cloudflare_session` |
| `app/(dashboard)/cameras/page.tsx` | Camera page — CAM-01 and CAM-02 |
| `app/api/cloudflare/signal/route.ts` | Server-side Cloudflare Realtime signaling proxy (keeps `CF_APP_SECRET` off the browser) |
| `app/api/edge/spindle_count/route.ts` | Proxies edge-worker `/spindle_count` — latest count per camera |
| `app/api/edge/cloudflare_session/route.ts` | Proxies edge-worker `/cloudflare_session` — processed session ID + track names |
| `docker-compose.yml` | 3 services: auth-postgres, nextjs, edge-worker |

---

## Docker services

| Service | Port | Notes |
|---------|------|-------|
| `nextjs` | 3000 | Dashboard |
| `edge-worker` | 8081 | WebRTC publisher + HTTP result receiver |
| `auth-postgres` | — | better-auth sessions DB |

---

## Environment variables

### Edge worker
| Variable | Default | Notes |
|----------|---------|-------|
| `CAMERA_SOURCES` | `{"CAM-01":"/app/video/pov1.mp4","CAM-02":"/app/video/pov2.mov"}` | JSON map of camera ID → source |
| `CF_APP_ID` | — | Cloudflare Realtime App ID |
| `CF_APP_SECRET` | — | Cloudflare Realtime App Secret |
| `CF_TRACK_NAMES` | `{"CAM-01":"cam-01","CAM-02":"cam-02"}` | Track name per camera |
| `TARGET_FPS` | 15 | Frame capture rate |
| `HTTP_PORT` | 8081 | Port for the HTTP result server |

### Next.js
| Variable | Notes |
|----------|-------|
| `CF_APP_ID` | Same Cloudflare App ID — used by signaling proxy |
| `CF_APP_SECRET` | Kept server-side in `/api/cloudflare/signal` |
| `EDGE_WORKER_HOST` | e.g. `http://edge-worker:8081` |

---

## How Colab sends results back

Colab POSTs to `http://<edge-worker-host>:8081/colab_result` after each inference batch:

```json
{
  "camera_id": "CAM-01",
  "count": 8,
  "detections": [
    {"x": 320, "y": 240, "width": 60, "height": 50, "confidence": 0.91, "class": "Car"}
  ],
  "processed_session_id": "<colab-cloudflare-session-id>",
  "processed_track_name": "cam-01-annotated"
}
```

The edge worker stores this; Next.js polls `/spindle_count` and `/cloudflare_session` to display it.

---

## Development workflow

```bash
# After any Python change in services/edge/:
docker compose up -d --build edge-worker

# After any Next.js change:
docker compose up -d --build nextjs

# Both at once:
docker compose up -d --build edge-worker nextjs

# Tail edge logs:
docker logs capstone-edge-worker-1 -f

# Verify Cloudflare publishing started:
docker logs capstone-edge-worker-1 | grep "Cloudflare Realtime"
```

---

## Critical constraints to remember

1. **Do not add extra `sleep()` in `_frame_reader_loop`** — `_capture_opencv` already paces file sources via `_next_frame_time`. A second sleep doubles the throttle.
2. **`last_model_frame` is 640×640 BGR numpy** — this is what gets published as WebRTC video frames. `last_frame` holds display-resolution JPEG bytes used only for health checks.
3. **`CF_APP_SECRET` never reaches the browser** — the `/api/cloudflare/signal` route is a server-side proxy. The browser only calls that Next.js route.
4. **Cloudflare session ID flow** — the edge worker gets its `publish_session_id` from Cloudflare when it starts. Colab must report its `processed_session_id` via HTTP POST so Next.js knows which session to subscribe to for annotated video.
5. **No local inference** — all ML runs in Colab. The edge worker is purely a camera relay + result receiver. Do not add inference code back here.
