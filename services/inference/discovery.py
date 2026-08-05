"""Discover the browser publisher's Cloudflare source sessions from Next.js.

Reads back what lib/webrtc/publisher.ts registered via POST
/api/cameras/register, so nothing has to be copied by hand between the
browser and this worker. Ported from capstone_inference.ipynb sections 2b
and 3.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import aiohttp

from config import (
    FALLBACK_CONFIDENCE,
    FALLBACK_INFERENCE_SHAPE,
    FALLBACK_MAX_DETECTIONS,
    FALLBACK_TARGET_CLASS_NAMES,
    class_names_from_str,
    shape_from_str,
)

logger = logging.getLogger("inference.discovery")


async def check_nextjs_reachable(base_url: str, headers: dict[str, str]) -> None:
    """Fail fast and loudly rather than silently dropping every count later."""
    url = f"{base_url}/api/inference/source"
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as response:
            body = await response.text()
            if response.status == 401:
                raise RuntimeError(
                    "Next.js rejected INFERENCE_API_KEY. Confirm it matches the "
                    "value in the project's .env."
                )
            if response.status == 404:
                logger.warning(
                    "Reached Next.js, but no source sessions are registered yet. "
                    "Turn a camera on at /cameras in the browser publisher and "
                    "confirm it shows PUBLISHING."
                )
                return
            if response.status >= 300:
                raise RuntimeError(f"HTTP {response.status} from {url}: {body[:300]}")
            logger.info("Next.js reachable; source sessions are registered.")


def parse_source_coordinates(raw: str) -> dict[str, Any]:
    """Fallback parser for a hand-supplied JSON or ENV block.

    Each camera carries its OWN sessionId, not one shared session: cameras
    never share a Cloudflare connection (see lib/webrtc/publisher.ts's
    PublisherController docstring for why bundling multiple tracks onto one
    connection does not work).
    """
    raw = raw.strip()
    if not raw:
        raise ValueError("No source coordinates were provided.")

    app_id = ""

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON source coordinates: {exc}") from exc

        app_id = str(data.get("appId", "")).strip()
        cameras_raw = data.get("cameras", [])
        if not isinstance(cameras_raw, list):
            raise ValueError("JSON field 'cameras' must be a list.")

        cameras = []
        for index, item in enumerate(cameras_raw, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"cameras[{index - 1}] must be an object.")
            cameras.append(
                {
                    "name": str(item.get("name") or f"Camera {index}").strip(),
                    "trackName": str(item.get("trackName", "")).strip(),
                    "cameraId": str(item.get("cameraId", "")).strip(),
                    "sessionId": str(item.get("sessionId", "")).strip(),
                }
            )
    else:
        env: dict[str, str] = {}
        for raw_line in raw.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                raise ValueError(f"Invalid ENV line: {raw_line!r}")
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()

        app_id = env.get("SOURCE_APP_ID", "").strip()
        try:
            camera_count = int(env.get("SOURCE_CAMERA_COUNT", "0"))
        except ValueError as exc:
            raise ValueError("SOURCE_CAMERA_COUNT must be an integer.") from exc

        cameras = []
        for index in range(1, camera_count + 1):
            prefix = f"SOURCE_CAMERA_{index}_"
            cameras.append(
                {
                    "name": env.get(f"{prefix}NAME", f"Camera {index}").strip(),
                    "trackName": env.get(f"{prefix}TRACK_NAME", "").strip(),
                    "cameraId": env.get(f"{prefix}CAMERA_ID", "").strip(),
                    "sessionId": env.get(f"{prefix}SESSION_ID", "").strip(),
                }
            )

    if not cameras:
        raise ValueError("No camera entries were found.")

    return {"cameras": cameras, "appId": app_id}


async def fetch_source_coordinates(
    base_url: str, headers: dict[str, str]
) -> dict[str, Any]:
    """Read the source sessions the browser publisher registered with Next.js."""
    url = f"{base_url}/api/inference/source"
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as response:
            body = await response.text()
            if response.status == 404:
                raise RuntimeError(
                    "No source sessions are registered. Turn a camera on at "
                    "/cameras in the browser publisher and wait for it to show "
                    "PUBLISHING."
                )
            if response.status >= 300:
                raise RuntimeError(f"HTTP {response.status} from {url}: {body[:300]}")
            data = json.loads(body)

    stale_cameras = [c["cameraId"] for c in data.get("cameras", []) if c.get("stale")]
    if stale_cameras:
        # The Cloudflare session is very likely already gone, which would
        # otherwise surface as an opaque Cloudflare error much later.
        raise RuntimeError(
            f"Source session(s) for {stale_cameras} are stale. "
            "Is the browser still publishing at /cameras?"
        )

    return data


def normalize_cameras(config: dict[str, Any]) -> dict[str, Any]:
    cameras = []
    seen_track_names: set[str] = set()
    for index, camera in enumerate(config.get("cameras", []), start=1):
        track_name = str(camera.get("trackName", "")).strip()
        if not track_name:
            raise ValueError(f"Camera {index} is missing trackName.")
        if track_name in seen_track_names:
            raise ValueError(f"Duplicate source trackName: {track_name}")
        seen_track_names.add(track_name)

        # Hand-supplied blocks predate cameraId; the browser publisher's track
        # names are the lowercased camera ids, so this recovers it.
        camera_id = str(camera.get("cameraId", "")).strip() or track_name.upper()

        session_id = str(camera.get("sessionId", "")).strip()
        if not session_id:
            raise ValueError(
                f"Camera {camera_id} is missing sessionId. Each camera needs its "
                "own Cloudflare session — see MANUAL_SOURCE_COORDINATES."
            )

        cameras.append(
            {
                "cameraId": camera_id,
                "trackName": track_name,
                "sessionId": session_id,
                "name": str(camera.get("name") or camera_id).strip(),
            }
        )

    if not cameras:
        raise ValueError("No camera entries were found.")
    return {
        "cameras": cameras,
        "appId": str(config.get("appId") or "").strip(),
        # Passed through as-is (or absent, for MANUAL_SOURCE_COORDINATES
        # blocks, which predate this field) — parsed by
        # resolve_inference_params, not here.
        "inference": config.get("inference"),
    }


async def discover_source_cameras(
    base_url: str,
    headers: dict[str, str],
    manual_source_coordinates: str,
    manual_app_id: str = "",
) -> dict[str, Any]:
    """Resolve the camera list and Cloudflare App ID to subscribe against.

    Taking the App ID from the same response as the sessions guarantees this
    worker and the browser publisher are on one Cloudflare application.
    Subscribing with a mismatched App ID fails late and unhelpfully.
    """
    if manual_source_coordinates.strip():
        source_config = normalize_cameras(
            parse_source_coordinates(manual_source_coordinates)
        )
        logger.info("Using MANUAL_SOURCE_COORDINATES.")
    else:
        source_config = normalize_cameras(
            await fetch_source_coordinates(base_url, headers)
        )
        logger.info("Discovered the source sessions from Next.js.")

    app_id = manual_app_id.strip() or (source_config.get("appId") or "")
    if not app_id:
        raise ValueError(
            "Next.js did not return a Cloudflare App ID. Set CF_APP_ID in the "
            "project's .env and restart the nextjs container, or set "
            "CF_APP_ID_OVERRIDE in this worker's environment."
        )
    source_config["appId"] = app_id
    return source_config


def resolve_inference_params(source_config: dict[str, Any]) -> dict[str, Any]:
    """Merge the RF-DETR-facing tunables Next.js served alongside the camera
    list (GET /api/inference/source's "inference" block) with this worker's
    hardcoded fallback constants — used only when that block is absent, e.g.
    a hand-supplied MANUAL_SOURCE_COORDINATES block that predates this field,
    or Next.js running an older version.
    """
    remote = source_config.get("inference") or {}

    confidence = remote.get("confidence")
    max_detections = remote.get("maxDetections")
    target_class_names = remote.get("targetClassNames")
    inference_shape = remote.get("inferenceShape")

    return {
        "confidence": float(confidence) if confidence is not None else FALLBACK_CONFIDENCE,
        "max_detections": (
            int(max_detections) if max_detections is not None else FALLBACK_MAX_DETECTIONS
        ),
        "target_class_names": (
            class_names_from_str(target_class_names)
            if target_class_names is not None
            else FALLBACK_TARGET_CLASS_NAMES
        ),
        "inference_shape": (
            shape_from_str(inference_shape)
            if inference_shape is not None
            else FALLBACK_INFERENCE_SHAPE
        ),
    }
