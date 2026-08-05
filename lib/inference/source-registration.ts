/**
 * Validation for browser-submitted source-session registrations.
 *
 * Split out from the route handler so it can be unit tested — the route itself
 * is mostly auth plumbing, but this is the part that stands between an
 * authenticated browser and the registry the GPU inference worker trusts.
 *
 * Every logged-in user can publish, so this input is only as trustworthy as any
 * other user input. Two invariants matter downstream:
 *
 *   - `services/inference/discovery.py`'s normalize_cameras() rejects duplicate
 *     track names, so trackName is not really accepted from the client at all —
 *     it is looked up from lib/cameras.ts and must match what the client sent.
 *   - An unknown camera id would be handed to the GPU worker, which would try
 *     to subscribe to a Cloudflare track that does not exist and fail at
 *     startup. So ids are checked against the same list.
 */

import { isKnownCameraId, trackNameFor } from '@/lib/cameras'

/** Same charset the signaling proxy allows for a session id path segment. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9]{1,64}$/

export interface ParsedSessions {
  [cameraId: string]: { sessionId: string; trackName: string }
}

export type ParseResult =
  | { ok: true; sessions: ParsedSessions }
  | { ok: false; error: string }

export function parseSourceRegistration(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object.' }
  }

  const raw = (body as Record<string, unknown>).sessions
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'sessions must be an object mapping camera id to {sessionId, trackName}.',
    }
  }

  const sessions: ParsedSessions = {}

  for (const [cameraId, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!isKnownCameraId(cameraId)) {
      return { ok: false, error: `Unknown camera id: ${cameraId}` }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: `${cameraId}: entry must be an object.` }
    }

    const entry = value as Record<string, unknown>
    const sessionId = String(entry.sessionId ?? '').trim()
    const trackName = String(entry.trackName ?? '').trim()

    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return {
        ok: false,
        error: `${cameraId}: sessionId must be 1-64 alphanumeric characters.`,
      }
    }

    const expected = trackNameFor(cameraId)
    if (trackName !== expected) {
      return {
        ok: false,
        error: `${cameraId}: trackName must be "${expected}", got "${trackName}".`,
      }
    }

    sessions[cameraId] = { sessionId, trackName }
  }

  if (Object.keys(sessions).length === 0) {
    return { ok: false, error: 'sessions is empty.' }
  }

  return { ok: true, sessions }
}
