"""Batch and ship per-frame detections to Next.js, and keep the processed
(annotated) Cloudflare sessions registered.

Ported from capstone_inference.ipynb sections 6b and 7.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any, Optional

import aiohttp

logger = logging.getLogger("inference.reporter")


class DetectionReporter:
    """Batches per-frame detections and ships them to Next.js.

    Deliberately fire-and-forget: every failure path logs and drops. Counting
    degrading is far preferable to the annotated video stream stalling.

    Two properties matter more than throughput here:

    - It can never stall the video track. push() only appends to a bounded
      deque; all network I/O happens on a separate task.
    - It drops rather than queues. The deque is capped, so an outage cannot
      grow memory without bound. Dropping the oldest frames is the right
      loss: the server takes max() over a short window, so frames from an
      outage several seconds ago would be discarded anyway.
    """

    def __init__(
        self,
        camera_id: str,
        base_url: str,
        headers: dict[str, str],
        flush_interval: float,
        maxlen: int,
    ):
        self.camera_id = camera_id
        self.url = f"{base_url}/api/inference/detections"
        self.headers = headers
        self.flush_interval = flush_interval
        self._buffer: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._task: Optional[asyncio.Task[None]] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self.frames_sent = 0
        self.frames_dropped = 0
        self.failures = 0
        self.last_error: Optional[str] = None

    def push(
        self,
        ts_ms: float,
        inference_ms: float,
        detections: list[dict[str, Any]],
    ) -> None:
        """Called from the video track. Must stay synchronous and cheap."""
        if len(self._buffer) == self._buffer.maxlen:
            # deque silently evicts the oldest; count it so the loss is
            # visible in logs rather than being invisible.
            self.frames_dropped += 1
        self._buffer.append(
            {
                "ts": round(ts_ms, 1),
                "inferenceMs": round(inference_ms, 2),
                "detections": detections,
            }
        )

    async def start(self) -> None:
        timeout = aiohttp.ClientTimeout(total=10)
        self._session = aiohttp.ClientSession(timeout=timeout)
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.flush_interval)
                await self._flush()
        except asyncio.CancelledError:
            # Best-effort final flush so the last visit is not lost on
            # shutdown.
            await self._flush()
            raise

    async def _flush(self) -> None:
        if not self._buffer or self._session is None:
            return

        frames = list(self._buffer)
        self._buffer.clear()

        try:
            async with self._session.post(
                self.url,
                json={"cameraId": self.camera_id, "frames": frames},
                headers=self.headers,
            ) as response:
                if response.status >= 300:
                    body = await response.text()
                    self.failures += 1
                    self.last_error = f"HTTP {response.status}: {body[:200]}"
                    if self.failures <= 3 or self.failures % 20 == 0:
                        logger.warning(
                            "[%s] report failed — %s", self.camera_id, self.last_error
                        )
                else:
                    self.frames_sent += len(frames)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failures += 1
            self.last_error = repr(exc)
            if self.failures <= 3 or self.failures % 20 == 0:
                logger.warning(
                    "[%s] report failed — %s", self.camera_id, self.last_error
                )

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except BaseException:
                pass
            self._task = None
        if self._session is not None:
            await self._session.close()
            self._session = None


async def register_processed_sessions(
    base_url: str,
    headers: dict[str, str],
    sessions: dict[str, dict[str, str]],
) -> None:
    """Tell Next.js which Cloudflare session carries each camera's annotated
    track. Each camera has its own session (see webrtc.py / pipeline.py for
    why) so the payload is keyed per camera rather than carrying one shared
    sessionId:

        {"role": "processed",
         "sessions": {"CAM-01": {"sessionId": "...", "trackName": "..."}}}
    """
    url = f"{base_url}/api/inference/register"
    payload = {"role": "processed", "sessions": sessions}
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            url, json=payload, headers=headers
        ) as response:
            if response.status >= 300:
                body = await response.text()
                raise RuntimeError(f"HTTP {response.status} from {url}: {body[:300]}")


async def processed_heartbeat_loop(
    base_url: str,
    headers: dict[str, str],
    sessions: dict[str, dict[str, str]],
    interval_seconds: float = 15.0,
) -> None:
    """Re-register on an interval so Next.js can tell a dead pipeline from a
    quiet one, and mark the dashboard's inference indicator offline if this
    worker stops."""
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await register_processed_sessions(base_url, headers, sessions)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Processed heartbeat failed: %r", exc)
