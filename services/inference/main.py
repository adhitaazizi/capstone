"""GPU inference worker — the native-Python counterpart to
capstone_inference.ipynb.

Same pipeline, same three endpoints (GET /api/inference/source, POST
/api/inference/detections, POST /api/inference/register), same division of
labour: this process does RF-DETR inference and annotation only. Spindle-
boundary filtering, interval sampling, max(), the MAX_HOTWHEELS plausibility
check, visit segmentation and cross-camera pairing all happen server-side in
Next.js (see lib/inference/), so those stay tunable via .env without
touching this file.

Run it wherever there is a CUDA GPU — a workstation, a rented GPU box, a
container started with --gpus — instead of only inside Colab. The notebook
remains usable directly if that is more convenient for a given session.

    python main.py

Configuration is entirely via environment variables / services/inference/.env
— see config.py and services/inference/.env.example.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Any

from config import load_config
from discovery import check_nextjs_reachable, discover_source_cameras, resolve_inference_params
from model import (
    class_names as get_class_names,
    load_checkpoint,
    optimize_and_warmup,
    require_cuda,
    validate_target_class_names,
)
from pipeline import start_multi_camera_pipeline, stop_multi_camera_pipeline
from webrtc import resolve_ice_servers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("inference")

STATS_INTERVAL_SECONDS = 30.0


async def _stats_loop(pipeline: dict[str, Any]) -> None:
    """Periodic replacement for capstone_inference.ipynb's manually re-run
    "inspect pipelines" cell — this worker runs unattended, so it logs
    instead."""
    while True:
        await asyncio.sleep(STATS_INTERVAL_SECONDS)
        for item in pipeline["camera_pipelines"]:
            stats = item["stats"]
            reporter = item["reporter"]
            logger.info(
                "%s: processed=%d fps=%.1f last_inference_ms=%.1f objects=%d "
                "reported=%d dropped=%d failures=%d%s",
                stats.camera_id,
                stats.processed_frames,
                stats.processed_fps,
                stats.last_inference_ms,
                stats.last_object_count,
                reporter.frames_sent,
                reporter.frames_dropped,
                reporter.failures,
                f" last_error={reporter.last_error!r}" if reporter.last_error else "",
            )


async def run() -> None:
    config = load_config()

    if not config.inference_api_key:
        raise ValueError("INFERENCE_API_KEY is not set.")
    if not config.cf_app_secret:
        raise ValueError("CF_APP_SECRET is not set.")

    if config.require_cuda:
        require_cuda()

    headers = {"x-inference-key": config.inference_api_key}

    await check_nextjs_reachable(config.nextjs_base_url, headers)
    source_config = await discover_source_cameras(
        config.nextjs_base_url,
        headers,
        config.manual_source_coordinates,
        config.cf_app_id_override,
    )
    source_cameras = source_config["cameras"]
    app_id = source_config["appId"]
    logger.info("Cloudflare App ID: %s", app_id)
    logger.info("Source cameras (each on its own Cloudflare session):")
    for camera in source_cameras:
        logger.info(
            "- %s (%s): session %s, track %s",
            camera["cameraId"], camera["name"], camera["sessionId"], camera["trackName"],
        )

    ice_servers = await resolve_ice_servers(
        config.cf_turn_key_id, config.cf_turn_key_token
    )

    inference_params = resolve_inference_params(source_config)
    logger.info(
        "Inference params (Next.js-served unless noted fallback): "
        "confidence=%.2f max_detections=%d target_class_names=%s inference_shape=%s",
        inference_params["confidence"],
        inference_params["max_detections"],
        sorted(inference_params["target_class_names"]) or "*",
        inference_params["inference_shape"] or "checkpoint default",
    )

    model = load_checkpoint(config.checkpoint_path, config.trust_checkpoint)
    model_class_names = get_class_names(model)
    validate_target_class_names(inference_params["target_class_names"], model_class_names)
    optimize_and_warmup(
        model,
        optimize_for_inference=config.optimize_for_inference,
        optimize_compile=config.optimize_compile,
        optimize_inplace=config.optimize_inplace,
        use_half_precision=config.use_half_precision,
        confidence=inference_params["confidence"],
        inference_shape=inference_params["inference_shape"],
    )
    logger.info("RF-DETR checkpoint loaded. Classes: %s", model_class_names)

    stop_event = asyncio.Event()

    def _handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Signal %d received — shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    pipeline = await start_multi_camera_pipeline(
        app_id=app_id,
        app_secret=config.cf_app_secret,
        source_cameras=source_cameras,
        model=model,
        model_class_names=model_class_names,
        confidence=inference_params["confidence"],
        max_detections=inference_params["max_detections"],
        target_class_names=inference_params["target_class_names"] or None,
        inference_shape=inference_params["inference_shape"],
        ice_servers=ice_servers,
        base_url=config.nextjs_base_url,
        headers=headers,
        report_flush_seconds=config.report_flush_seconds,
        report_buffer_maxlen=config.report_buffer_maxlen,
    )

    stats_task = asyncio.create_task(_stats_loop(pipeline))
    try:
        await stop_event.wait()
    finally:
        stats_task.cancel()
        try:
            await stats_task
        except asyncio.CancelledError:
            pass
        await stop_multi_camera_pipeline(pipeline)
        logger.info("Inference worker stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
