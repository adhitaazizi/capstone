# Inference worker

The native-Python counterpart to [`capstone_inference.ipynb`](../../capstone_inference.ipynb):
same pipeline, same contract with Next.js, but env-driven instead of
interactive notebook cells, so it can run unattended on any machine with a
CUDA GPU instead of only inside Colab. Pick whichever is more convenient for
a given session — they are interchangeable, not both required.

**This worker does RF-DETR inference and annotation only.** Spindle-boundary
filtering, `DETECTION_INTERVAL` windowing, `max()`, the `MAX_HOTWHEELS`
plausibility filter, visit segmentation, and FIFO cross-camera pairing all
live server-side in `lib/inference/` and are tuned by editing the project's
`.env` and restarting the `nextjs` container — this worker never needs to
change for that.

```
browser (/cameras) ──publish cam-01/cam-02──► Cloudflare Realtime
     │                                                │
     └─POST /api/cameras/register──────┐              │ (raw tracks)
                                        ▼              ▼
                                    Next.js         THIS WORKER
                                        ▲              │  GET  /api/inference/source
                                        │              │  POST /api/inference/detections
                                        └──────────────┤  POST /api/inference/register
                                                        │
                                                        └─publish annotated──► Cloudflare
                                                                                    │
                                       browser (/cameras) ◄─subscribe processed─────┘
```

## Module map

| File | Role |
|------|------|
| `config.py` | Env-backed configuration (mirrors `services/edge/config.py`'s style) |
| `discovery.py` | Reads the edge worker's registered Cloudflare sessions from Next.js |
| `webrtc.py` | Cloudflare Realtime signaling client + aiortc/ICE helpers, incl. optional TURN |
| `model.py` | Loads the trained RF-DETR Medium checkpoint |
| `engine.py` | Runs inference against the newest frame per camera, annotates, normalizes boxes |
| `reporter.py` | Batches detections to `/api/inference/detections`; registers processed sessions |
| `pipeline.py` | Subscribe-all / publish-all / start / stop lifecycle |
| `main.py` | Entrypoint: config → discovery → model load → run until SIGINT/SIGTERM |

## Run it

### Prerequisites

1. `docker compose up -d nextjs` (or an already-running nextjs deployment),
   then turn a camera on at `/cameras` in the browser publisher — that's
   what registers a Cloudflare source session for this worker to discover.
2. Reachability to Next.js — same Docker network (`http://nextjs:3000`) or a
   public URL (e.g. a `cloudflared tunnel` for local dev, or the deployed
   URL on RunPod) if this worker runs on a separate machine/pod.
3. A trained checkpoint at `weights/checkpoint_best_total.pth` (or point
   `CHECKPOINT_PATH` elsewhere — see `weights/README.md`).

### Natively (on a machine with a CUDA GPU)

```powershell
python -m venv services\inference\.venv
services\inference\.venv\Scripts\python.exe -m pip install "torch>=2.2" "torchvision>=0.17" --index-url https://download.pytorch.org/whl/cu121
services\inference\.venv\Scripts\python.exe -m pip install -r services\inference\requirements.txt

copy services\inference\.env.example services\inference\.env
# edit services\inference\.env — at minimum INFERENCE_API_KEY and CF_APP_SECRET

cd services\inference
..\..\services\inference\.venv\Scripts\python.exe main.py
```

### Via Docker (best-effort — GPU passthrough varies by host)

```bash
docker compose --profile inference up -d --build inference
docker compose logs -f inference
```

This service is **profile-gated** (`profiles: ["inference"]` in
`docker-compose.yml`), so plain `docker compose up -d` never starts it —
opt in explicitly once a GPU host with the NVIDIA Container Toolkit is
available.

## Configuration

See `.env.example` for the full list. Values not set here fall back to the
project root `.env` (python-dotenv walks up the directory tree), so
`CF_APP_SECRET`, `INFERENCE_API_KEY`, `CF_TURN_KEY_ID` / `CF_TURN_KEY_TOKEN`
usually don't need to be duplicated.

Detection confidence, max detections, class filter, and inference resolution
are **not** configured here — Next.js's `system_settings` table
(`/settings/pipeline`) owns them and serves them to this worker on every
startup via `GET /api/inference/source`. `.env` here holds secrets,
connection info, and RF-DETR engine internals that have no Next.js Settings
equivalent (`OPTIMIZE_*`, `REPORT_*`, `REQUIRE_CUDA`, `TRUST_CHECKPOINT`,
`CHECKPOINT_PATH`).

The Cloudflare **App ID** is deliberately not a config value: it is
discovered from Next.js's registered source sessions (`GET
/api/inference/source`) every startup, so this worker can never silently
drift onto a different Cloudflare application than the browser publisher it
needs to subscribe to. Set `CF_APP_ID_OVERRIDE` only when also using
`MANUAL_SOURCE_COORDINATES` (Next.js unreachable).

## Troubleshooting

See the Troubleshooting section of `capstone_inference.ipynb` — every failure
mode there (401 from Next.js, stale source session, missing processed
session, checkpoint not found, wrong class names, CUDA OOM) applies
identically here; only the fix (an env var instead of a cell) differs.
