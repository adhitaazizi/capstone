/**
 * Browser publisher registration — session-authed counterpart to
 * app/api/inference/register/route.ts's 'processed' role.
 *
 * Every logged-in user can publish, so the body is untrusted input, not an
 * internal contract — see lib/inference/source-registration.ts's docstring
 * for why cameraId/trackName are checked against lib/cameras.ts rather than
 * accepted as-is.
 */

import { headers } from 'next/headers'

import { auth } from '@/lib/auth'
import { sessions } from '@/lib/inference/pipeline'
import { parseSourceRegistration } from '@/lib/inference/source-registration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseSourceRegistration(body)
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 })
  }

  const registry = sessions()

  // Surfaced to the operator as a "took over from another browser" warning —
  // this is a single-publisher-at-a-time model, so a differing sessionId for
  // a camera id that was already registered means someone else was
  // publishing it a moment ago.
  const replaced: string[] = []
  for (const [cameraId, { sessionId }] of Object.entries(parsed.sessions)) {
    const previous = registry.get('source', cameraId)
    if (previous && previous.sessionId !== sessionId) replaced.push(cameraId)
  }

  registry.register('source', parsed.sessions)

  return Response.json({
    status: 'ok',
    cameras: Object.keys(parsed.sessions),
    replaced,
  })
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Body is optional — pagehide's keepalive DELETE sends none, meaning
  // "clear everything this browser was publishing."
  let cameraIds: string[] | undefined
  try {
    const body = (await request.json()) as { cameraIds?: unknown }
    if (Array.isArray(body?.cameraIds)) {
      cameraIds = body.cameraIds.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    // No/empty body — fall through to clearing everything.
  }

  sessions().unregister('source', cameraIds)
  return Response.json({ status: 'ok' })
}
