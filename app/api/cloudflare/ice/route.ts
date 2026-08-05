/**
 * ICE server discovery for browser WebRTC connections.
 *
 * Mints short-lived Cloudflare TURN credentials server-side so CF_TURN_KEY_TOKEN
 * — a long-lived secret — never reaches the browser. The credentials returned
 * are intentionally short-lived and scoped to relaying media; that is what they
 * are for.
 *
 * This cannot go through /api/cloudflare/signal: that proxy hardcodes
 * `${CF_BASE}/apps/${appId}${path}`, and the TURN endpoint lives outside
 * /apps/{id}.
 *
 * TURN is usually unnecessary from a browser — a browser's ICE stack handles
 * NAT traversal properly, which is why components/camera-tile.tsx worked on
 * STUN alone. It earns its keep behind symmetric NAT or a firewall blocking
 * outbound UDP: the symptom is a connection stuck at 'checking' that ends in
 * iceConnectionState 'failed', with only host and srflx candidates visible in
 * chrome://webrtc-internals.
 *
 * Unset credentials are not an error — the route degrades to STUN, because a
 * missing TURN key should never be the reason the page cannot show video.
 */

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

import { auth } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CF_BASE = 'https://rtc.live.cloudflare.com/v1'
const TURN_TTL_SECONDS = 3600

const STUN_ONLY = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const keyId = process.env.CF_TURN_KEY_ID?.trim()
  const keyToken = process.env.CF_TURN_KEY_TOKEN?.trim()

  if (!keyId || !keyToken) {
    return NextResponse.json(STUN_ONLY)
  }

  try {
    const resp = await fetch(
      `${CF_BASE}/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        cache: 'no-store',
      }
    )

    if (!resp.ok) {
      console.warn(`[cloudflare] TURN credential request failed: ${resp.status}`)
      return NextResponse.json(STUN_ONLY)
    }

    const data = (await resp.json()) as { iceServers?: unknown }
    const iceServers = Array.isArray(data.iceServers)
      ? data.iceServers
      : data.iceServers
        ? [data.iceServers]
        : []

    if (iceServers.length === 0) {
      console.warn('[cloudflare] TURN response contained no ICE servers')
      return NextResponse.json(STUN_ONLY)
    }

    return NextResponse.json({ iceServers })
  } catch (error) {
    console.warn('[cloudflare] TURN credential request threw:', error)
    return NextResponse.json(STUN_ONLY)
  }
}
