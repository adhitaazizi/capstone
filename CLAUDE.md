@AGENTS.md

# SprayCount — Project Context for Claude

## What this project is

SprayCount is an industrial edge-AI system that counts Hot Wheels toys on rotating spindles at a spray painting station. Cameras watch each spindle complete one full rotation; the system counts unique toys, publishes entry/exit events to RabbitMQ, and a Next.js dashboard shows real-time production data.

**Team:** Muhammad Arrizky Adhita Azizi · Farrelio Gustiana Dzaki · Muhamad Aldi Apriansyah  
**University:** President University, Faculty of Computer Science (Capstone Design)

---

## Current implementation status

### Camera setup
- **2 cameras** active: `CAM-01` (entry, top view) and `CAM-02` (exit, side view)
- Both currently use `spindle-simulation.mp4` as file source (looping video for dev/demo)
- Real deployment uses RTSP cameras published through MediaMTX

### Inference pipeline
- **Roboflow local inference server** on host port 9001 (runs in a separate process outside Docker)
- Model: Hot Wheels RT-DETR (project `hot-wheels-recognition-qd0mi`, version 2)
- Confidence threshold: 0.75 (env `CONFIDENCE_THRESHOLD`)
- Inference latency: **~620 ms per call on CPU**
- Two cameras share a **class-level semaphore** (`threading.Semaphore(1)`) so only one inference call runs at a time — prevents the local server from queuing and inflating latency to 4–5 s
- Effective update rate: **~0.8 fps per camera** (~1.24 s between ML results)

### Visual tracking (tracking_stream.py)
Two threads per camera run in `TrackingStream`:

1. **Inference thread** (~0.8 fps per camera):
   - Grabs `last_model_frame` (640×640 numpy array)
   - Acquires class semaphore → calls `RoboflowInference.detect()` → releases
   - Updates `CentroidTracker` (centroid-distance matching, `MAX_DIST=200`, `MAX_MISSED=2`)
   - Calls `FlowTracker.snap()` to anchor box positions to ML ground truth

2. **Flow thread** (10 fps, every 100 ms):
   - Converts `last_model_frame` to grayscale
   - Tracks **one LK point per detection** (the box center) using `cv2.calcOpticalFlowPyrLK`
   - `winSize=(25,25), maxLevel=4` — large enough to handle ~200 px/frame displacement
   - Updates `_latest` with flow-interpolated positions
   - This fills the 1.24 s ML gap so boxes follow cars visually rather than freezing

**Why center-point, not goodFeaturesToTrack:** `goodFeaturesToTrack` spread across the full box includes spindle-arm background edges (high-contrast = strong corners). When a neighboring arm enters the box edge at a different rotation angle, those background features pull the box off the car. One point at the box centroid means the LK patch is centered on the car body.

### Counting logic (main.py + row_tracker.py)
- `RowTracker` clusters detections by Y-position into rows (tolerance: `ROW_Y_TOLERANCE=25` px)
- `_observe_spindle_entry` polls `TrackingStream.get_latest_detections()` every 500 ms
- When a previously-seen row reappears (spindle completed one rotation), counting stops
- Count = number of unique Y-clusters seen = toys on the spindle
- `FIFOReconciler` matches each entry event to the next exit event in order

### MJPEG server (mjpeg_server.py)
- Port 8081 (edge-worker container)
- `GET /stream/{camera_id}` — raw MJPEG at 15 fps (no annotations baked in)
- `GET /detections/{camera_id}` — JSON array of current tracked detections

### Browser overlay (components/camera-tile.tsx)
- Polls `/api/edge/detections/${cameraId}` every 100 ms
- Draws bounding boxes on a `<canvas>` overlay
- Scale: `scaleX = displayW / 640`, `scaleY = displayH / 640` (model outputs in 640×640 coords)
- Box colors from a palette indexed by `(det.id % TRACK_COLORS.length)`
- Label: `${det.class} ${confidence}%` (no ID displayed — track IDs increment freely as spindle rotates)

---

## Planned upgrade: ONNX inference

The current bottleneck is 620 ms CPU inference through the Roboflow local server. The upgrade path:

1. **Weights already exist:** `weights/checkpoint_best_total.pth` is an RT-DETR checkpoint
2. **Local inference class exists:** `services/edge/local_inference.py` uses `rfdetr.RFDETRBase` to load the `.pth` directly — no Roboflow server needed
3. **ONNX export target:** `weights/spraycount-rtdetr-v1.onnx` (see `weights/README.md`)
4. **Alternatively:** Train a YOLOv8n on the Roboflow dataset, export to ONNX → ~50–100 ms CPU inference

When the ONNX file is ready, integrate it into `services/edge/inference.py` using `onnxruntime` and remove the dependency on the external Roboflow server.

---

## Key file map

| File | Role |
|------|------|
| `services/edge/main.py` | `EdgeOrchestrator` — entry/exit loops, frame readers, health |
| `services/edge/tracking_stream.py` | `TrackingStream`, `CentroidTracker`, `FlowTracker` |
| `services/edge/frame_capture.py` | `FrameCapture` — RTSP via PyAV, file via OpenCV, capped at 15 fps |
| `services/edge/row_tracker.py` | `RowTracker` — Y-cluster rotation detection |
| `services/edge/inference.py` | `RoboflowInference` — HTTP client to local Roboflow server |
| `services/edge/local_inference.py` | `LocalRTDETRInference` — direct `.pth` or ONNX inference (not yet active) |
| `services/edge/mjpeg_server.py` | HTTP server at :8081 for /stream and /detections |
| `services/edge/deduplication.py` | `CrossCameraDeduplicator` (runs in identity mode for 2 cameras) |
| `services/edge/reconciler.py` | `FIFOReconciler` — FIFO entry/exit pairing |
| `services/edge/publisher.py` | `EdgePublisher` — RabbitMQ AMQP publisher |
| `services/edge/config.py` | `EdgeConfig` — all env var loading |
| `services/edge/rtsp_mjpeg_bridge.py` | Standalone RTSP→MJPEG bridge (used by `rtsp-bridge` container) |
| `components/camera-tile.tsx` | Live feed + detection canvas overlay |
| `components/local-camera-grid.tsx` | Camera grid layout |
| `app/(dashboard)/cameras/page.tsx` | Camera page — hardcodes CAM-01 and CAM-02 |
| `app/api/edge/detections/[cameraId]/route.ts` | Next.js proxy → edge-worker:8081/detections/{id} |
| `app/api/stream/[cameraId]/route.ts` | Next.js proxy → edge-worker:8081/stream/{id} |
| `docker-compose.yml` | Full stack: auth-postgres, rabbitmq, mediamtx, nextjs, edge-worker, rtsp-bridge, prometheus, grafana |
| `weights/checkpoint_best_total.pth` | RT-DETR model weights (for local_inference.py) |

---

## Docker services

| Service | Port | Notes |
|---------|------|-------|
| `nextjs` | 3000 | Dashboard |
| `edge-worker` | 8081 | MJPEG + detection JSON |
| `rtsp-bridge` | 8080 | RTSP→MJPEG for live cameras (not active in file-source dev) |
| `rabbitmq` | 5672, 15672 | Message bus |
| `mediamtx` | 8554, 8888, 8889 | Media routing (RTSP/HLS/WebRTC) |
| `prometheus` | 9090 | Metrics scraper |
| `grafana` | 3001 | Monitoring dashboards |
| `persistence-worker` | — | Consumes RabbitMQ, writes Supabase |
| `auth-postgres` | — | better-auth sessions DB |

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

# Check inference is running:
docker logs capstone-edge-worker-1 --tail 20 | grep inference
```

---

## Critical constraints to remember

1. **Do not add extra `sleep()` in `_frame_reader_loop`** — `_capture_opencv` already paces file sources via `_next_frame_time`. A second sleep doubles the throttle (was causing 10 fps instead of 15 fps).
2. **Semaphore is class-level** (`TrackingStream._inference_sem`) — shared across ALL camera instances. This is intentional: prevents the Roboflow local server from receiving parallel calls.
3. **Detection coordinates are in 640×640 space** — `last_model_frame` is always resized to 640×640 before inference. The MJPEG stream (`last_frame`) is 640×360 (or proportional) but the canvas overlay scales independently using `displayW/640` and `displayH/640`.
4. **Track IDs are not stable across spindle rotations** — as the spindle rotates, cars leave and re-enter the camera frame. Each re-entry creates a new centroid track (new ID). This is expected behavior; the RowTracker uses Y-position, not track IDs, for counting.
5. **CONFIDENCE_THRESHOLD=0.75** — set high to reduce false positives on spindle arm structure. Lowering it increases recall but also increases spurious detections.
