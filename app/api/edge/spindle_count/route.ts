import { NextRequest } from 'next/server'

export async function GET(_request: NextRequest) {
  const host = process.env.EDGE_WORKER_HOST || 'http://edge-worker:8081'
  try {
    const res = await fetch(`${host}/spindle_count`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return Response.json({ counts: {}, rotation_number: 0 })
    return Response.json(await res.json())
  } catch {
    return Response.json({ counts: {}, rotation_number: 0 })
  }
}
