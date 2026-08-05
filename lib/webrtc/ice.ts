/**
 * Client-side ICE server resolution.
 *
 * Memoised because every camera opens its own PeerConnection and the viewer
 * tiles reconnect with backoff — without this, a flapping connection would mint
 * fresh TURN credentials on every retry.
 *
 * Never throws. If the route is unreachable the caller still gets STUN, which
 * is what worked before TURN existed here; failing the whole publish because
 * ICE configuration could not be fetched would be a worse outcome than trying.
 */

import { SessionExpiredError } from '@/lib/webrtc/signal'

/** Comfortably inside the 3600 s TTL the route requests. */
const CACHE_TTL_MS = 30 * 60 * 1000

const STUN_ONLY: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

let cached: { servers: RTCIceServer[]; fetchedAt: number } | null = null
let inFlight: Promise<RTCIceServer[]> | null = null

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.servers
  }
  // Collapse concurrent calls — both cameras start publishing at once.
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const resp = await fetch('/api/cloudflare/ice', { cache: 'no-store' })

      if (
        resp.redirected ||
        !resp.headers.get('content-type')?.includes('application/json')
      ) {
        throw new SessionExpiredError()
      }
      if (!resp.ok) {
        throw new Error(`ICE server request failed (${resp.status})`)
      }

      const data = (await resp.json()) as { iceServers?: RTCIceServer[] }
      const servers =
        Array.isArray(data.iceServers) && data.iceServers.length > 0
          ? data.iceServers
          : STUN_ONLY

      cached = { servers, fetchedAt: Date.now() }
      return servers
    } catch (error) {
      // Deliberately not cached: a transient failure should not pin the app to
      // STUN for half an hour when TURN is configured and would work.
      console.warn('[webrtc] falling back to STUN:', error)
      return STUN_ONLY
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/**
 * Drop the memoised credentials, so the next call re-mints them. Used when a
 * connection fails and a retry might benefit from fresh TURN credentials.
 */
export function clearIceServerCache(): void {
  cached = null
}
