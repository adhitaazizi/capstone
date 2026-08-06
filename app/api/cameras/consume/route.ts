/**
 * Annotated-stream consumer heartbeat.
 *
 * components/camera-tile.tsx POSTs here every time it observes framesDecoded
 * advance, which is what opens the counting gate in lib/inference/pipeline.ts.
 * See lib/inference/consumers.ts for why "a viewer is decoding frames" is the
 * signal the pipeline keys on rather than "the worker is POSTing detections".
 *
 * Session-authed like app/api/cameras/register/route.ts, not
 * `x-inference-key`: the caller is a logged-in browser, not the GPU worker.
 * And like that route, the body is untrusted user input — anyone with a
 * session could POST an arbitrary cameraId — so ids are checked against
 * lib/cameras.ts. A forged sessionId does not weaken the gate, since
 * isCounting() still requires it to equal the processed session the registry
 * holds for that camera.
 */

import { headers } from 'next/headers'

import { auth } from '@/lib/auth'
import { isKnownCameraId } from '@/lib/cameras'
import { consumers } from '@/lib/inference/pipeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same charset the signaling proxy allows for a session id path segment. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9]{1,64}$/

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const cameraId = String(body.cameraId ?? '').trim()
  if (!isKnownCameraId(cameraId)) {
    return Response.json(
      { error: `Unknown camera id: ${cameraId}` },
      { status: 400 }
    )
  }

  const sessionId = String(body.sessionId ?? '').trim()
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json(
      { error: 'sessionId must be 1-64 alphanumeric characters.' },
      { status: 400 }
    )
  }

  consumers().heartbeat(cameraId, sessionId)

  return Response.json({ status: 'ok', cameraId })
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Body is optional — the keepalive DELETE fired on teardown may send none,
  // meaning "this browser has stopped watching everything".
  let cameraIds: string[] | undefined
  try {
    const body = (await request.json()) as { cameraIds?: unknown }
    if (Array.isArray(body?.cameraIds)) {
      cameraIds = body.cameraIds.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    // No/empty body — fall through to clearing everything.
  }

  consumers().release(cameraIds)
  return Response.json({ status: 'ok' })
}
