import { NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  context: RouteContext<'/api/stream/[cameraId]'>
) {
  const { cameraId } = await context.params
  // Prefer the edge-worker's annotated stream; fall back to rtsp-bridge plain stream
  const host = process.env.EDGE_STREAM_HOST || process.env.ESP32_HOST || 'http://edge-worker:8081'
  const baseUrl = host.startsWith('http') ? host : `http://${host}`
  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/stream/${cameraId}`, {
    cache: 'no-store',
    headers: { 'Connection': 'close' },
  })

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: 'stream_unavailable', cameraId },
      { status: upstream.status || 502 }
    )
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ||
        'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  })
}
