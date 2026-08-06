/**
 * Dashboard poll: everything the camera page needs in one request.
 *
 * Replaces the old pair of /api/edge/* polls, which returned counts the edge
 * worker never actually received and a "rotation number" that incremented once
 * per POST rather than once per rotation.
 */

import { headers } from 'next/headers'

import { auth } from '@/lib/auth'
import {
  countingCameras,
  currentSpindleNumber,
  liveStates,
  queueDepth,
  recentPairs,
  sessions,
  tick,
} from '@/lib/inference/pipeline'
import { ENTRY_CAMERA_ID, EXIT_CAMERA_ID } from '@/lib/inference/constants'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Close any windows that elapsed since the last ingest. Without this a visit
  // stays open forever once Colab stops sending frames.
  const now = Date.now()
  tick(now)

  const registry = sessions()

  // Each camera has its own Cloudflare session — cameras never share one, so
  // there is no single top-level "the" session id (see registry.ts).
  //
  // liveProcessed(), not getAll(): a processed registration outlives the
  // publisher it was derived from, and serving a stale one hands the dashboard
  // a track that negotiates cleanly and decodes nothing. The tile then covers
  // the operator's own camera preview with a black rectangle badged ONLINE,
  // which reads as a broken camera rather than a worker still bound to a
  // session Cloudflare already reaped.
  const processedSessions = registry.liveProcessed(now)

  // Which cameras are actually being counted. Everything else in this response
  // is meaningless while this is empty: detections are being dropped, so the
  // counts below are frozen at whatever they were when the last viewer went
  // away. The dashboard uses this to show a waiting state rather than stale
  // numbers that look live. See lib/inference/consumers.ts.
  const counting = countingCameras(now)

  const cameras: Record<string, unknown> = {}
  for (const state of liveStates()) {
    cameras[state.cameraId] = {
      spindlePresent: state.spindlePresent,
      intervalCount: state.intervalCount,
      lastVisitCount: state.lastVisitCount,
      lastSampleAt: state.lastSampleAt,
      framesReceived: state.framesReceived,
    }
  }

  return Response.json({
    entryCameraId: ENTRY_CAMERA_ID,
    exitCameraId: EXIT_CAMERA_ID,
    // { [cameraId]: { sessionId, trackName } }
    processedSessions: Object.fromEntries(
      Object.entries(processedSessions).map(([cameraId, entry]) => [
        cameraId,
        { sessionId: entry.sessionId, trackName: entry.trackName },
      ])
    ),
    cameras,
    counting: { active: counting.length > 0, cameras: counting },
    recentPairs: recentPairs(10),
    queueDepth: queueDepth(),
    currentSpindleNumber: currentSpindleNumber(),
    health: {
      sourceOnline: registry.hasFreshAny('source', now),
      // Same standard as processedSessions above, deliberately: a worker that
      // is heartbeating but pointed at a replaced publisher is not "online" in
      // any sense the operator cares about.
      processedOnline: Object.keys(processedSessions).length > 0,
    },
  })
}
