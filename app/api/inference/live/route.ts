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
  const processedSessions = registry.getAll('processed')

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
    recentPairs: recentPairs(10),
    queueDepth: queueDepth(),
    health: {
      sourceOnline: registry.hasFreshAny('source', now),
      processedOnline: registry.hasFreshAny('processed', now),
    },
  })
}
