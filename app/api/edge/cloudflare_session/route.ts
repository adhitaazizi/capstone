import { NextRequest } from 'next/server'

export async function GET(_: NextRequest) {
  const host = process.env.EDGE_WORKER_HOST || 'http://edge-worker:8081'
  try {
    const res = await fetch(`${host}/cloudflare_session`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return Response.json({})
    return Response.json(await res.json())
  } catch {
    return Response.json({})
  }
}
