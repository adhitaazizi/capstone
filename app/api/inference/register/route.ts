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
 *
 * 'processed' entries may also carry `sourceSessionId` — the source session the
 * annotated track was subscribed to. Without it the dashboard cannot tell an
 * annotated track that is still fed by the current publisher from one whose
 * publisher was replaced (see CameraSession.sourceSessionId).
 */

import { checkInferenceKey } from '@/lib/inference/auth'
import { sessions } from '@/lib/inference/pipeline'
import type { ProducerRole, SessionRegistration } from '@/lib/inference/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 'source' is deliberately absent. Source sessions come from the browser
// publisher via the session-authenticated /api/cameras/register, so accepting
// them here too would leave a second path — reachable by anyone holding
// INFERENCE_API_KEY — to point the source registry at an arbitrary Cloudflare
// session. The GPU inference worker only ever registers 'processed'.
const ROLES: ProducerRole[] = ['processed']

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

  const parsed: Record<string, SessionRegistration> = {}
  for (const [cameraId, value] of Object.entries(rawSessions)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const sessionId = String(entry.sessionId ?? '').trim()
    const trackName = String(entry.trackName ?? '').trim()
    // Which source session this annotated track was built from. Optional:
    // capstone_inference.ipynb does not send it, and an absent value must stay
    // absent rather than becoming '' — see CameraSession.sourceSessionId for
    // why "unknown" and "matches nothing" have to stay distinguishable.
    const sourceSessionId = String(entry.sourceSessionId ?? '').trim()
    if (sessionId && trackName) {
      parsed[cameraId] = {
        sessionId,
        trackName,
        ...(sourceSessionId ? { sourceSessionId } : {}),
      }
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
