import { NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  context: RouteContext<'/api/edge/detections/[cameraId]'>
) {
  const { cameraId } = await context.params
  const host = process.env.EDGE_WORKER_HOST || 'http://edge-worker:8081'
  try {
    const res = await fetch(`${host}/detections/${cameraId}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return Response.json({ detections: [], camera_id: cameraId })
    return Response.json(await res.json())
  } catch {
    return Response.json({ detections: [], camera_id: cameraId })
  }
}
