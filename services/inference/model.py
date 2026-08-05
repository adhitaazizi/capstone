"""Load the trained RF-DETR Medium checkpoint.

Ported from capstone_inference.ipynb section 4. RFDETR.from_checkpoint() is
tried first so the architecture and class count are inferred from the
checkpoint, falling back to RFDETRMedium(pretrain_weights=...) for older
checkpoints that lack enough metadata.
"""

from __future__ import annotations

import logging
import warnings
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from rfdetr import RFDETR, RFDETRMedium

logger = logging.getLogger("inference.model")


def require_cuda() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError(
            "No CUDA GPU is visible to PyTorch. Run this worker on a machine "
            "with an NVIDIA GPU and CUDA drivers installed, or set "
            "REQUIRE_CUDA=false to force (much slower) CPU inference."
        )
    logger.info("GPU: %s", torch.cuda.get_device_name(0))
    logger.info("PyTorch: %s", torch.__version__)


def load_checkpoint(checkpoint_path: Path, trust_checkpoint: bool) -> RFDETR:
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"RF-DETR checkpoint was not found: {checkpoint_path}")

    logger.info("Loading RF-DETR checkpoint: %s", checkpoint_path)
    try:
        model = RFDETR.from_checkpoint(
            checkpoint_path, trust_checkpoint=trust_checkpoint
        )
    except ValueError as auto_detect_error:
        warnings.warn(
            "The checkpoint architecture could not be inferred automatically. "
            "Falling back to RFDETRMedium(pretrain_weights=...). "
            f"Original error: {auto_detect_error}"
        )
        model = RFDETRMedium(
            pretrain_weights=str(checkpoint_path),
            trust_checkpoint=trust_checkpoint,
        )

    loaded_model_class = type(model).__name__
    if "Medium" not in loaded_model_class:
        warnings.warn(
            f"The checkpoint reconstructed {loaded_model_class}, not "
            "RFDETRMedium. Verify that CHECKPOINT_PATH points to the "
            "intended Medium checkpoint."
        )
    logger.info("Checkpoint reconstructed as: %s", loaded_model_class)
    return model


def class_names(model: RFDETR) -> list[str]:
    names = [str(name) for name in model.class_names]
    if not names:
        raise RuntimeError("The checkpoint did not expose any class names.")
    return names


def validate_target_class_names(
    target_class_names: frozenset[str],
    available: list[str],
) -> None:
    """target_class_names is already casefolded (see config.class_names_from_str)."""
    available_folded = {name.casefold() for name in available}
    missing = [name for name in target_class_names if name not in available_folded]
    if missing:
        raise ValueError(
            f"Unknown target class name(s): {missing}. Available classes: "
            f"{available}. This is set at /settings/pipeline in Next.js, or "
            "TARGET_CLASS_NAMES in a MANUAL_SOURCE_COORDINATES block."
        )


def optimize_and_warmup(
    model: RFDETR,
    *,
    optimize_for_inference: bool,
    optimize_compile: bool,
    optimize_inplace: bool,
    use_half_precision: bool,
    confidence: float,
    inference_shape: Optional[tuple[int, int]],
) -> None:
    if optimize_for_inference:
        model.inference(
            compile=optimize_compile,
            batch_size=1,
            dtype=torch.float16 if use_half_precision else torch.float32,
            inplace=optimize_inplace,
        )

    # Warm up once so checkpoint initialization does not happen during
    # WebRTC signaling, where a slow first inference could stall connection
    # setup past Cloudflare's timeouts.
    warmup_height, warmup_width = inference_shape or (576, 576)
    warmup_image = np.zeros((warmup_height, warmup_width, 3), dtype=np.uint8)
    warmup_kwargs: dict[str, object] = {
        "threshold": confidence,
        "include_source_image": False,
    }
    if inference_shape is not None:
        warmup_kwargs["shape"] = inference_shape
    _ = model.predict(warmup_image, **warmup_kwargs)
