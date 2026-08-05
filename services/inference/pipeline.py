"""Subscribe to every source track, run RF-DETR, and publish the annotated
output — the full multi-camera pipeline lifecycle.

Ported from capstone_inference.ipynb section 7.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Any, Optional

from aiortc import (
    MediaStreamTrack,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from rfdetr import RFDETR

from engine import (
    CameraPipelineStats,
    LatestFrameBuffer,
    RFDETRProcessedVideoTrack,
    RFDETRStreamingEngine,
)
from reporter import (
    DetectionReporter,
    processed_heartbeat_loop,
    register_processed_sessions,
)
from webrtc import (
    CloudflareRealtimeAPI,
    description_from_result,
    force_all_video_transceivers_to_vp8,
    force_vp8,
    rtc_configuration,
    set_complete_local_description,
    wait_for_connection,
)

logger = logging.getLogger("inference.pipeline")


async def subscribe_to_cloudflare_video(
    app_id: str,
    app_secret: str,
    source_session_id: str,
    source_track_name: str,
    ice_servers: "list[RTCIceServer]",
) -> tuple[RTCPeerConnection, CloudflareRealtimeAPI, MediaStreamTrack]:
    api = CloudflareRealtimeAPI(app_id, app_secret)
    pc = RTCPeerConnection(rtc_configuration(ice_servers))
    loop = asyncio.get_running_loop()
    video_future: asyncio.Future[MediaStreamTrack] = loop.create_future()

    @pc.on("track")
    def _on_track(track: MediaStreamTrack) -> None:
        logger.info(
            "Received source track %s: kind=%s, id=%s",
            source_track_name, track.kind, track.id,
        )
        if track.kind == "video" and not video_future.done():
            video_future.set_result(track)

    # Negotiate a receive-only VP8 video m-line from the beginning.
    receive_transceiver = pc.addTransceiver("video", direction="recvonly")
    force_vp8(receive_transceiver)

    offer = await pc.createOffer()
    local_offer = await set_complete_local_description(
        pc, offer, stage=f"subscriber {source_track_name}: initial offer"
    )
    session_result = await api.new_session(local_offer.sdp)
    await pc.setRemoteDescription(description_from_result(session_result))
    await wait_for_connection(
        pc, stage=f"subscriber {source_track_name}: initial connection"
    )

    pull_result = await api.new_tracks(
        [
            {
                "location": "remote",
                "sessionId": source_session_id,
                "trackName": source_track_name,
            }
        ]
    )

    if pull_result.get("requiresImmediateRenegotiation"):
        description = pull_result.get("sessionDescription")
        if not description or description.get("type") != "offer":
            raise RuntimeError(
                "Cloudflare requested renegotiation but did not return an offer."
            )
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=description["sdp"], type=description["type"])
        )
        force_all_video_transceivers_to_vp8(pc)
        answer = await pc.createAnswer()
        local_answer = await set_complete_local_description(
            pc,
            answer,
            stage=f"subscriber {source_track_name}: renegotiation answer",
        )
        await api.renegotiate(local_answer.sdp)
    elif pull_result.get("sessionDescription"):
        await pc.setRemoteDescription(description_from_result(pull_result))

    try:
        remote_video = await asyncio.wait_for(video_future, timeout=60.0)
    except TimeoutError as exc:
        raise TimeoutError(
            f"Cloudflare did not deliver source video track "
            f"{source_session_id} / {source_track_name} within 60s."
        ) from exc

    return pc, api, remote_video


def slugify_track_part(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return slug or "camera"


async def publish_cloudflare_video(
    app_id: str,
    app_secret: str,
    track: MediaStreamTrack,
    track_name: str,
    ice_servers: "list[RTCIceServer]",
) -> tuple[RTCPeerConnection, CloudflareRealtimeAPI, str]:
    """Publish ONE track to its own, independent Cloudflare session.

    Each camera gets its own RTCPeerConnection rather than sharing one
    connection with multiple tracks — see services/edge/main.py's
    CameraPublisher docstring for why bundling multiple tracks onto one
    connection does not work against Cloudflare Realtime.
    """
    api = CloudflareRealtimeAPI(app_id, app_secret)
    pc = RTCPeerConnection(rtc_configuration(ice_servers))

    transceiver = pc.addTransceiver(track, direction="sendonly")
    force_vp8(transceiver)

    offer = await pc.createOffer()
    local_offer = await set_complete_local_description(
        pc, offer, stage=f"processed publisher {track_name}: initial offer"
    )
    session_result = await api.new_session(local_offer.sdp)
    await pc.setRemoteDescription(description_from_result(session_result))

    if transceiver.mid is None:
        raise RuntimeError(f"Cloudflare did not assign a media MID for {track_name}.")

    # Match the working browser sequence: register the local track, then
    # wait for the PeerConnection to reach connected/completed.
    registration_offer = await pc.createOffer()
    local_registration_offer = await set_complete_local_description(
        pc,
        registration_offer,
        stage=f"processed publisher {track_name}: track registration offer",
    )
    tracks_result = await api.new_tracks(
        [{"location": "local", "mid": transceiver.mid, "trackName": track_name}],
        offer_sdp=local_registration_offer.sdp,
    )
    await pc.setRemoteDescription(description_from_result(tracks_result))
    await wait_for_connection(
        pc, timeout_seconds=90.0, stage=f"processed publisher {track_name} connection"
    )

    if not api.session_id:
        raise RuntimeError(f"Processed publisher session ID is missing for {track_name}.")
    return pc, api, api.session_id


async def start_multi_camera_pipeline(
    *,
    app_id: str,
    app_secret: str,
    source_cameras: list[dict[str, Any]],
    model: RFDETR,
    model_class_names: list[str],
    confidence: float,
    max_detections: int,
    target_class_names: Optional[frozenset[str]],
    inference_shape: Optional[tuple[int, int]],
    ice_servers: "list[RTCIceServer]",
    base_url: str,
    headers: dict[str, str],
    report_flush_seconds: float,
    report_buffer_maxlen: int,
) -> dict[str, Any]:
    engine = RFDETRStreamingEngine(
        model=model,
        model_class_names=model_class_names,
        confidence=confidence,
        max_detections=max_detections,
        target_class_names=target_class_names or None,
        inference_shape=inference_shape,
    )

    run_suffix = uuid.uuid4().hex[:8]
    camera_pipelines: list[dict[str, Any]] = []
    heartbeat_task: Optional[asyncio.Task[None]] = None

    try:
        for index, camera in enumerate(source_cameras, start=1):
            camera_id = camera["cameraId"]
            name = camera["name"]
            source_session_id = camera["sessionId"]
            source_track_name = camera["trackName"]
            output_track_name = f"rfdetr-m-{slugify_track_part(camera_id)}-{run_suffix}"

            logger.info(
                "[%d/%d] Subscribing to %s / %s...",
                index, len(source_cameras), camera_id, source_track_name,
            )
            subscriber_pc, subscriber_api, source_track = (
                await subscribe_to_cloudflare_video(
                    app_id,
                    app_secret,
                    source_session_id,
                    source_track_name,
                    ice_servers,
                )
            )

            stats = CameraPipelineStats(
                camera_id=camera_id,
                camera_name=name,
                source_track_name=source_track_name,
                output_track_name=output_track_name,
                started_at=time.monotonic(),
            )
            frame_buffer = LatestFrameBuffer(source_track, stats)
            logger.info("Waiting for first decodable VP8 frame: %s...", camera_id)
            await frame_buffer.wait_for_first_frame(timeout_seconds=60.0)
            logger.info("First frame received: %s", camera_id)

            # Keyed on the canonical camera id, which is what the server's
            # entry/exit pairing is configured against.
            reporter = DetectionReporter(
                camera_id=camera_id,
                base_url=base_url,
                headers=headers,
                flush_interval=report_flush_seconds,
                maxlen=report_buffer_maxlen,
            )
            await reporter.start()

            processed_track = RFDETRProcessedVideoTrack(
                source_buffer=frame_buffer,
                engine=engine,
                stats=stats,
                reporter=reporter,
            )

            camera_pipelines.append(
                {
                    "camera": camera,
                    "camera_id": camera_id,
                    "subscriber_pc": subscriber_pc,
                    "subscriber_api": subscriber_api,
                    "source_track": source_track,
                    "frame_buffer": frame_buffer,
                    "processed_track": processed_track,
                    "reporter": reporter,
                    "stats": stats,
                    "output_track_name": output_track_name,
                    "publisher_pc": None,
                }
            )
            logger.info("Connected: %s", camera_id)

        logger.info(
            "Publishing %d processed RF-DETR Medium tracks "
            "(one Cloudflare session per camera)...",
            len(camera_pipelines),
        )
        publish_results = await asyncio.gather(
            *(
                publish_cloudflare_video(
                    app_id,
                    app_secret,
                    item["processed_track"],
                    item["output_track_name"],
                    ice_servers,
                )
                for item in camera_pipelines
            )
        )
        for item, (publisher_pc, _publisher_api, session_id) in zip(
            camera_pipelines, publish_results
        ):
            item["publisher_pc"] = publisher_pc
            item["processed_session_id"] = session_id

        processed_sessions = {
            item["camera_id"]: {
                "sessionId": item["processed_session_id"],
                "trackName": item["output_track_name"],
            }
            for item in camera_pipelines
        }

        # Registering is what makes the dashboard show the annotated video; a
        # failure here is worth surfacing rather than swallowing.
        await register_processed_sessions(base_url, headers, processed_sessions)
        heartbeat_task = asyncio.create_task(
            processed_heartbeat_loop(base_url, headers, processed_sessions)
        )
        logger.info("Registered processed sessions with %s", base_url)

        pipeline = {
            "engine": engine,
            "camera_pipelines": camera_pipelines,
            "heartbeat_task": heartbeat_task,
            "processed_sessions": processed_sessions,
        }

        logger.info("=" * 88)
        logger.info("PIPELINE RUNNING")
        for camera_id, entry in processed_sessions.items():
            logger.info(
                "  %s -> session %s / track %s",
                camera_id, entry["sessionId"], entry["trackName"],
            )
        logger.info(
            "The dashboard discovers these automatically at /cameras. "
            "Counts appear once a spindle has passed both cameras."
        )
        logger.info("=" * 88)
        return pipeline

    except BaseException:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
        for item in camera_pipelines:
            await item["reporter"].close()
            await item["frame_buffer"].close()
            await item["subscriber_pc"].close()
            publisher_pc = item.get("publisher_pc")
            if publisher_pc is not None:
                await publisher_pc.close()
        raise


async def stop_multi_camera_pipeline(pipeline: Optional[dict[str, Any]]) -> None:
    if not pipeline:
        return

    heartbeat_task = pipeline.get("heartbeat_task")
    if heartbeat_task is not None:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except BaseException:
            pass

    for item in pipeline.get("camera_pipelines", []):
        reporter = item.get("reporter")
        if reporter is not None:
            # Closing flushes whatever is still buffered before tearing down.
            await reporter.close()
        frame_buffer = item.get("frame_buffer")
        if frame_buffer is not None:
            await frame_buffer.close()
        subscriber_pc = item.get("subscriber_pc")
        if subscriber_pc is not None:
            await subscriber_pc.close()
        publisher_pc = item.get("publisher_pc")
        if publisher_pc is not None:
            await publisher_pc.close()

    logger.info("Multi-camera pipeline stopped.")
