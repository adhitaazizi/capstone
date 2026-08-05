/**
 * Cloudflare Realtime signaling helpers shared by the publisher and the viewer.
 *
 * Every Cloudflare call goes through `/api/cloudflare/signal`, the server-side
 * proxy that holds CF_APP_SECRET. The browser never sees Cloudflare credentials.
 * The proxy allow-lists exactly the three paths both roles need:
 *   POST /sessions/new
 *   POST /sessions/{id}/tracks/new
 *   PUT  /sessions/{id}/renegotiate
 *
 * Extracted from components/camera-tile.tsx so lib/webrtc/publisher.ts — which
 * is not a React module — can use the same, already-proven implementations.
 */

/**
 * Thrown when the auth session expired mid-call.
 *
 * `proxy.ts` matches /api/cloudflare/* and redirects an unauthenticated request
 * to /login, which is itself exempt from the matcher and therefore renders a
 * 200 HTML page. A default fetch() follows that redirect, so the caller sees
 * `ok: true` and then a bewildering "Unexpected token '<'" from resp.json().
 * Detecting it here turns that into a message an operator can act on.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired. Reload the page and sign in again.')
    this.name = 'SessionExpiredError'
  }
}

const ICE_GATHERING_TIMEOUT_MS = 10_000

/**
 * Resolve once ICE gathering completes, or after a timeout.
 *
 * The listener and the timer are both cleaned up on either path. An earlier
 * inline version left the `icegatheringstatechange` listener attached and never
 * cleared its timeout, so every reconnect leaked both.
 */
export function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false

    // Declared as hoisted functions so `finish` can close over `timer`, which
    // is assigned synchronously below and therefore always set by the time
    // either the timeout or the listener can fire.
    function finish() {
      if (settled) return
      settled = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }

    function onChange() {
      if (pc.iceGatheringState === 'complete') finish()
    }

    pc.addEventListener('icegatheringstatechange', onChange)
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS)
  })
}

/** Forward one signaling call to Cloudflare through the server-side proxy. */
export async function signal(
  path: string,
  body: unknown,
  method?: string
): Promise<any> {
  const resp = await fetch('/api/cloudflare/signal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, body, method }),
  })

  // A redirect to the HTML login page, not a JSON error — see SessionExpiredError.
  if (
    resp.redirected ||
    !resp.headers.get('content-type')?.includes('application/json')
  ) {
    throw new SessionExpiredError()
  }

  if (!resp.ok) {
    // Cloudflare's errorDescription is genuinely useful when present, and a
    // bare status code sends you looking in the wrong place.
    let detail = ''
    try {
      const data = await resp.json()
      detail = data?.errorDescription || data?.error || ''
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }
    throw new Error(
      `Signaling failed (${resp.status}) for ${path}${detail ? `: ${detail}` : ''}`
    )
  }

  return resp.json()
}

/**
 * Set the local description and wait for ICE gathering to finish.
 *
 * Cloudflare's REST signaling is non-trickle: the SDP we post must already
 * carry its candidates, so every offer and answer goes through here.
 */
export async function setLocalAndGather(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit
): Promise<RTCSessionDescription> {
  await pc.setLocalDescription(description)
  await waitForIceGathering(pc)
  if (!pc.localDescription) {
    throw new Error('No local description after ICE gathering.')
  }
  return pc.localDescription
}
