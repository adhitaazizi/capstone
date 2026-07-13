import { NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  context: RouteContext<'/api/stream/[cameraId]'>
) {
  const { cameraId } = await context.params
  const rawHost = process.env.ESP32_HOST || 'http://rtsp-bridge:8080'
  const baseUrl = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`
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
