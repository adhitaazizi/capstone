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
from typing import Any, Optional

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

# How often to re-check which Cloudflare session each camera is publishing on.
SOURCE_POLL_SECONDS = 10.0

# Consecutive failed discovery polls tolerated before the pipeline is torn down.
# One failure is usually a Next.js restart or a network blip and must not kill a
# working pipeline; a sustained run of them means the browser publisher is gone,
# and holding a pipeline bound to a dead session is worse than waiting for a new
# one.
SOURCE_FAILURES_BEFORE_RESTART = 3


async def _sleep_unless_stopped(stop_event: asyncio.Event, seconds: float) -> None:
    """Sleep, but wake immediately on shutdown so Ctrl-C is not held hostage by
    a retry backoff."""
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


def _source_fingerprint(source_config: dict[str, Any]) -> dict[str, str]:
    """Camera id -> the Cloudflare session it is currently published on.

    Only the session id matters for change detection: the track name is derived
    from the camera id and is stable across republishes, so comparing it would
    miss exactly the case this exists to catch.
    """
    return {
        camera["cameraId"]: camera["sessionId"]
        for camera in source_config["cameras"]
    }


def _log_source_cameras(source_config: dict[str, Any]) -> None:
    logger.info("Cloudflare App ID: %s", source_config["appId"])
    logger.info("Source cameras (each on its own Cloudflare session):")
    for camera in source_config["cameras"]:
        logger.info(
            "- %s (%s): session %s, track %s",
            camera["cameraId"], camera["name"], camera["sessionId"], camera["trackName"],
        )


async def _wait_for_sources(
    config: Any, headers: dict[str, str], stop_event: asyncio.Event
) -> Optional[dict[str, Any]]:
    """Block until the browser publisher has a camera on, or until shutdown.

    Discovery used to fail hard here, which made start order matter: the worker
    had to be launched *after* an operator pressed "Turn camera ON". That is
    backwards for a process meant to sit unattended on a GPU box, and it turned
    every publisher restart into a manual worker restart too.

    Returns None only when stop_event fires.
    """
    while not stop_event.is_set():
        try:
            return await discover_source_cameras(
                config.nextjs_base_url,
                headers,
                config.manual_source_coordinates,
                config.cf_app_id_override,
            )
        except Exception as exc:
            logger.warning(
                "No usable source sessions yet (%s). Turn a camera on at "
                "/cameras; retrying in %.0fs.",
                exc,
                SOURCE_POLL_SECONDS,
            )
            await _sleep_unless_stopped(stop_event, SOURCE_POLL_SECONDS)
    return None


async def _watch_source_sessions(
    config: Any,
    headers: dict[str, str],
    baseline: dict[str, str],
    restart_event: asyncio.Event,
) -> None:
    """Signal a restart when the publisher behind any camera is replaced.

    aiortc binds to a Cloudflare session id at subscribe time and has no way to
    notice it was swapped: the peer connection stays up, the SFU keeps the
    m-line alive, and frames simply stop arriving. The annotated output then
    keeps heartbeating as perfectly healthy while carrying nothing at all.

    The browser mints a fresh session on every reload of /cameras, every device
    change, and every takeover from another machine — so this is the common
    case, not an edge case. Polling the registry is what turns a silent black
    stream into a re-subscribe.
    """
    failures = 0
    while True:
        await asyncio.sleep(SOURCE_POLL_SECONDS)
        try:
            latest = await discover_source_cameras(
                config.nextjs_base_url,
                headers,
                config.manual_source_coordinates,
                config.cf_app_id_override,
            )
        except Exception as exc:
            failures += 1
            logger.warning(
                "Source discovery failed (%d/%d): %s",
                failures, SOURCE_FAILURES_BEFORE_RESTART, exc,
            )
            if failures >= SOURCE_FAILURES_BEFORE_RESTART:
                logger.warning(
                    "Source sessions have been unavailable for %.0fs — tearing "
                    "the pipeline down and waiting for a publisher.",
                    failures * SOURCE_POLL_SECONDS,
                )
                restart_event.set()
                return
            continue

        failures = 0
        current = _source_fingerprint(latest)
        if current != baseline:
            logger.info(
                "Source sessions changed (%s -> %s) — restarting the pipeline.",
                baseline, current,
            )
            restart_event.set()
            return


async def _wait_for_stop_or_restart(
    stop_event: asyncio.Event, restart_event: asyncio.Event
) -> None:
    waiters = [
        asyncio.create_task(stop_event.wait()),
        asyncio.create_task(restart_event.wait()),
    ]
    try:
        await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for waiter in waiters:
            waiter.cancel()


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

    stop_event = asyncio.Event()

    def _handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Signal %d received — shutting down", signum)
        stop_event.set()

    # Installed before the first discovery wait, so Ctrl-C works while the
    # worker is sitting there waiting for an operator to turn a camera on.
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    await check_nextjs_reachable(config.nextjs_base_url, headers)

    # The first discovery happens before the checkpoint load because the RF-DETR
    # warmup is shaped by the tunables Next.js serves alongside the camera list.
    source_config = await _wait_for_sources(config, headers, stop_event)
    if source_config is None:
        return
    _log_source_cameras(source_config)

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

    # MANUAL_SOURCE_COORDINATES pins the sessions by hand, so there is nothing
    # to re-discover — the watcher would only re-parse a constant and compare it
    # to itself.
    watch_sources = not config.manual_source_coordinates.strip()
    if not watch_sources:
        logger.info(
            "MANUAL_SOURCE_COORDINATES is set — source-session watching is off. "
            "Restart this worker by hand after the publisher restarts."
        )

    # The model stays loaded across restarts; only the WebRTC half is rebuilt.
    # That is what makes reacting to a publisher swap cheap enough to do
    # automatically rather than leaving it to an operator.
    while not stop_event.is_set():
        inference_params = resolve_inference_params(source_config)
        try:
            pipeline = await start_multi_camera_pipeline(
                app_id=source_config["appId"],
                app_secret=config.cf_app_secret,
                source_cameras=source_config["cameras"],
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
        except asyncio.CancelledError:
            raise
        except Exception:
            # Most often the publisher vanished between discovery and the first
            # frame — recoverable, and not worth losing the loaded checkpoint
            # over.
            logger.exception(
                "Pipeline failed to start — retrying in %.0fs.", SOURCE_POLL_SECONDS
            )
            await _sleep_unless_stopped(stop_event, SOURCE_POLL_SECONDS)
        else:
            restart_event = asyncio.Event()
            stats_task = asyncio.create_task(_stats_loop(pipeline))
            watch_task = (
                asyncio.create_task(
                    _watch_source_sessions(
                        config,
                        headers,
                        _source_fingerprint(source_config),
                        restart_event,
                    )
                )
                if watch_sources
                else None
            )
            try:
                await _wait_for_stop_or_restart(stop_event, restart_event)
            finally:
                for task in (stats_task, watch_task):
                    if task is None:
                        continue
                    task.cancel()
                    try:
                        await task
                    except BaseException:
                        pass
                await stop_multi_camera_pipeline(pipeline)

        if stop_event.is_set():
            break

        source_config = await _wait_for_sources(config, headers, stop_event)
        if source_config is None:
            break
        _log_source_cameras(source_config)

    logger.info("Inference worker stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
