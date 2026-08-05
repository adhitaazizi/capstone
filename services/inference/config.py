"""Configuration for the GPU inference worker.

This is the native-Python counterpart to capstone_inference.ipynb: the same
pipeline, but env-driven instead of interactive input()/getpass() cells, so
it can run unattended on any machine with a CUDA GPU (a workstation, a rented
GPU box, a container with --gpus) instead of only inside Colab.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

_ = load_dotenv()

# services/inference/config.py -> services/inference -> services -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[2]

# Detection sensitivity (confidence/max_detections/target_class_names/
# inference_shape) is genuinely tunable, but that knob already lives in
# Next.js's system_settings table (/settings/pipeline) and is served to this
# worker per-request via GET /api/inference/source — see
# discovery.resolve_inference_params. These constants are its fallback only,
# for when that block is absent (MANUAL_SOURCE_COORDINATES or an older
# Next.js), so they are NOT env-backed — an .env override would just be a
# second, driftable source of truth for a value Next.js already owns.
FALLBACK_CONFIDENCE = 0.35
FALLBACK_MAX_DETECTIONS = 100
FALLBACK_TARGET_CLASS_NAMES: frozenset[str] = frozenset()
FALLBACK_INFERENCE_SHAPE: Optional[tuple[int, int]] = None


@dataclass(frozen=True)
class InferenceConfig:
    # Where Next.js lives. Same Docker network: http://nextjs:3000. A GPU
    # machine outside that network (e.g. a separate RunPod pod): a publicly
    # reachable URL for the nextjs deployment.
    nextjs_base_url: str
    inference_api_key: str

    # Cloudflare Realtime app secret — same value as CF_APP_SECRET in the
    # project root .env. The App ID itself is deliberately NOT configured
    # here; it is discovered from Next.js's registered source sessions so
    # this worker can never drift onto a different Cloudflare application
    # than the browser publisher it needs to subscribe to.
    cf_app_secret: str
    cf_app_id_override: str
    cf_turn_key_id: str
    cf_turn_key_token: str

    checkpoint_path: Path
    # Only enable for a checkpoint you created or fully trust — .pth files
    # can contain arbitrary pickled Python objects.
    trust_checkpoint: bool

    # Fallback source-camera coordinates (JSON or ENV block), used only when
    # Next.js is unreachable. See discovery.parse_source_coordinates.
    manual_source_coordinates: str

    # RF-DETR engine internals. Next.js's system_settings table covers the
    # sampling pipeline (spindle boundaries, windowing, FIFO pairing), not
    # these — they have no dynamic-settings equivalent, and with this worker
    # running as a Docker container, an .env change + restart is far cheaper
    # to iterate on than a code edit + CUDA image rebuild.
    optimize_for_inference: bool
    optimize_compile: bool
    optimize_inplace: bool
    use_half_precision: bool

    # How often buffered detections are POSTed to Next.js, and how many
    # frames are buffered before the oldest are dropped (see reporter.py).
    report_flush_seconds: float
    report_buffer_maxlen: int

    # Fail fast if no CUDA GPU is visible. False only to force (much slower)
    # CPU inference, e.g. for a quick smoke test.
    require_cuda: bool


def load_config() -> InferenceConfig:
    return InferenceConfig(
        nextjs_base_url=os.environ.get(
            "NEXTJS_BASE_URL", "http://localhost:3000"
        ).rstrip("/"),
        inference_api_key=os.environ.get("INFERENCE_API_KEY", "").strip(),
        cf_app_secret=os.environ.get("CF_APP_SECRET", "").strip(),
        cf_app_id_override=os.environ.get("CF_APP_ID_OVERRIDE", "").strip(),
        cf_turn_key_id=os.environ.get("CF_TURN_KEY_ID", "").strip(),
        cf_turn_key_token=os.environ.get("CF_TURN_KEY_TOKEN", "").strip(),
        checkpoint_path=_resolve_checkpoint_path(),
        trust_checkpoint=_bool("TRUST_CHECKPOINT", True),
        manual_source_coordinates=os.environ.get("MANUAL_SOURCE_COORDINATES", ""),
        optimize_for_inference=_bool("OPTIMIZE_FOR_INFERENCE", True),
        optimize_compile=_bool("OPTIMIZE_COMPILE", False),
        optimize_inplace=_bool("OPTIMIZE_INPLACE", True),
        use_half_precision=_bool("USE_HALF_PRECISION", True),
        report_flush_seconds=float(os.environ.get("REPORT_FLUSH_SECONDS", "0.5")),
        report_buffer_maxlen=int(os.environ.get("REPORT_BUFFER_MAXLEN", "200")),
        require_cuda=_bool("REQUIRE_CUDA", True),
    )


def _resolve_checkpoint_path() -> Path:
    raw = os.environ.get(
        "CHECKPOINT_PATH", str(_REPO_ROOT / "weights" / "checkpoint_best_total.pth")
    )
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (_REPO_ROOT / path).resolve()
    return path


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def class_names_from_str(raw: str) -> frozenset[str]:
    """Parse the comma-separated class filter — same string format whether it
    comes from TARGET_CLASS_NAMES locally or targetClassNames in Next.js's
    GET /api/inference/source response (see discovery.resolve_inference_params)."""
    return frozenset(part.strip().casefold() for part in raw.split(",") if part.strip())


def shape_from_str(raw: str) -> Optional[tuple[int, int]]:
    """Parse 'HEIGHT,WIDTH' — same string format whether it comes from
    INFERENCE_SHAPE locally or inferenceShape remotely."""
    raw = raw.strip()
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 2:
        raise ValueError("INFERENCE_SHAPE must be 'HEIGHT,WIDTH', e.g. '576,576'")
    return int(parts[0]), int(parts[1])
