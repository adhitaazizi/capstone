/**
 * Cloudflare session registration + liveness heartbeat.
 *
 * `role: "source"`    — the edge worker, publishing raw camera tracks.
 * `role: "processed"` — Colab, publishing annotated tracks.
 *
 * Both re-POST every 15 s; a missing heartbeat is how the dashboard tells a
 * dead producer from a quiet one.
 *
 * Body shape is per-camera, not one shared session for every camera, because
 * each camera negotiates its own independent Cloudflare Realtime session —
 * bundling multiple tracks onto one connection does not work against
 * Cloudflare's SFU (see services/edge/main.py's CameraPublisher docstring):
 *
 *   { "role": "source",
 *     "sessions": { "CAM-01": { "sessionId": "...", "trackName": "cam-01" } } }
 */

import { checkInferenceKey } from '@/lib/inference/auth'
import { sessions } from '@/lib/inference/pipeline'
import type { ProducerRole } from '@/lib/inference/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROLES: ProducerRole[] = ['source', 'processed']

export async function POST(request: Request) {
  const denied = checkInferenceKey(request)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const role = String(body.role ?? '') as ProducerRole
  if (!ROLES.includes(role)) {
    return Response.json(
      { error: `role must be one of ${ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  const rawSessions = body.sessions
  if (
    typeof rawSessions !== 'object' ||
    rawSessions === null ||
    Array.isArray(rawSessions)
  ) {
    return Response.json(
      {
        error:
          'sessions must be an object mapping camera id to {sessionId, trackName}',
      },
      { status: 400 }
    )
  }

  const parsed: Record<string, { sessionId: string; trackName: string }> = {}
  for (const [cameraId, value] of Object.entries(rawSessions)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const sessionId = String(entry.sessionId ?? '').trim()
    const trackName = String(entry.trackName ?? '').trim()
    if (sessionId && trackName) {
      parsed[cameraId] = { sessionId, trackName }
    }
  }

  if (Object.keys(parsed).length === 0) {
    return Response.json(
      { error: 'sessions is empty or missing sessionId/trackName' },
      { status: 400 }
    )
  }

  sessions().register(role, parsed)

  return Response.json({ status: 'ok', role, cameras: Object.keys(parsed) })
}
