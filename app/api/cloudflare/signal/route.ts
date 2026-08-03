import { NextRequest, NextResponse } from 'next/server'

const CF_BASE = 'https://rtc.live.cloudflare.com/v1'

export async function POST(request: NextRequest) {
  const appId = process.env.CF_APP_ID
  const appSecret = process.env.CF_APP_SECRET
  if (!appId || !appSecret) {
    return NextResponse.json({ error: 'Cloudflare credentials not configured' }, { status: 503 })
  }

  const { path, body, method = 'POST' } = (await request.json()) as {
    path: string
    body: unknown
    method?: string
  }

  const url = `${CF_BASE}/apps/${appId}${path}`
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appSecret}`,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  const data = await resp.json()
  return NextResponse.json(data, { status: resp.status })
}
