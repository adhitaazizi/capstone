/**
 * Source-session discovery for Colab.
 *
 * Replaces the hand-pasted SOURCE_COORDINATES block: the notebook GETs this at
 * startup and learns which Cloudflare session and track name each camera is
 * currently publishing on. The `cameraId` in each entry is canonical — key
 * everything downstream on it, not on the display name.
 *
 * Each camera carries its own `sessionId`: cameras do not share a session.
 * Bundling multiple tracks onto one Cloudflare connection does not work
 * against Cloudflare's SFU — see services/edge/main.py's CameraPublisher
 * docstring for why every camera negotiates an independent connection.
 */

import { checkInferenceKey } from '@/lib/inference/auth'
import {
  INFERENCE_CONFIDENCE,
  INFERENCE_MAX_DETECTIONS,
  INFERENCE_SHAPE,
  INFERENCE_TARGET_CLASS_NAMES,
} from '@/lib/inference/constants'
import { sessions } from '@/lib/inference/pipeline'
import { REGISTRATION_STALE_MS } from '@/lib/inference/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const denied = checkInferenceKey(request)
  if (denied) return denied

  const registry = sessions()
  const byCamera = registry.getAll('source')
  const cameraIds = Object.keys(byCamera)

  if (cameraIds.length === 0) {
    return Response.json(
      {
        error:
          'No source sessions registered. Start the edge worker and confirm it ' +
          'can reach this app at NEXTJS_BASE_URL.',
      },
      { status: 404 }
    )
  }

  const now = Date.now()
  const cameras = cameraIds.map((cameraId) => {
    const entry = byCamera[cameraId]
    const ageMs = now - entry.updatedAt
    return {
      cameraId,
      sessionId: entry.sessionId,
      trackName: entry.trackName,
      name: cameraId,
      // Surfaced rather than hidden: a stale registration usually means the
      // edge worker died and its Cloudflare session is already gone, so
      // subscribing would fail with a confusing Cloudflare error instead of a
      // clear one.
      heartbeatAgeMs: ageMs,
      stale: ageMs >= REGISTRATION_STALE_MS,
    }
  })

  return Response.json({
    // Served so Colab cannot end up on a different Cloudflare app than the
    // edge worker is publishing to. The App ID is an identifier, not a
    // credential — CF_APP_SECRET is never sent anywhere.
    appId: process.env.CF_APP_ID ?? null,
    cameras,
    // RF-DETR-facing tunables, not secrets: how the worker should interpret
    // the frames it receives. Served here rather than living in the
    // worker's own .env so they stay tunable from this project's .env even
    // when the worker runs on a separate, harder-to-redeploy machine.
    inference: {
      confidence: INFERENCE_CONFIDENCE,
      maxDetections: INFERENCE_MAX_DETECTIONS,
      targetClassNames: INFERENCE_TARGET_CLASS_NAMES,
      inferenceShape: INFERENCE_SHAPE,
    },
  })
}
