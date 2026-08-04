/**
 * Server-side Cloudflare Realtime signaling proxy.
 *
 * Exists so CF_APP_SECRET never reaches the browser. Because it forwards a
 * caller-supplied path while bearing that secret, it must be both authenticated
 * and constrained to the handful of signaling endpoints a viewer legitimately
 * needs — otherwise any visitor could drive arbitrary Cloudflare Realtime API
 * calls against the application's account.
 */

import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'

import { auth } from '@/lib/auth'

const CF_BASE = 'https://rtc.live.cloudflare.com/v1'

/** Session ids are hex; anchoring the patterns stops path traversal too. */
const SESSION_ID = '[a-zA-Z0-9]{1,64}'
const ALLOWED_PATHS: { pattern: RegExp; methods: string[] }[] = [
  { pattern: new RegExp(`^/sessions/new$`), methods: ['POST'] },
  { pattern: new RegExp(`^/sessions/${SESSION_ID}/tracks/new$`), methods: ['POST'] },
  { pattern: new RegExp(`^/sessions/${SESSION_ID}/renegotiate$`), methods: ['PUT'] },
]

function isAllowed(path: string, method: string): boolean {
  return ALLOWED_PATHS.some(
    (rule) => rule.pattern.test(path) && rule.methods.includes(method)
  )
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const appId = process.env.CF_APP_ID
  const appSecret = process.env.CF_APP_SECRET
  if (!appId || !appSecret) {
    return NextResponse.json(
      { error: 'Cloudflare credentials not configured' },
      { status: 503 }
    )
  }

  let payload: { path?: unknown; body?: unknown; method?: unknown }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const path = String(payload.path ?? '')
  const method = String(payload.method ?? 'POST').toUpperCase()

  if (!isAllowed(path, method)) {
    console.warn(`[cloudflare] blocked signaling path: ${method} ${path}`)
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 })
  }

  const resp = await fetch(`${CF_BASE}/apps/${appId}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appSecret}`,
    },
    body: JSON.stringify(payload.body),
    cache: 'no-store',
  })

  const data = await resp.json()
  return NextResponse.json(data, { status: resp.status })
}
