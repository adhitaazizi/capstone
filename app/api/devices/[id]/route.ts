import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import type { CameraRow } from '@/lib/supabase/types'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if ((session.user as any).role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  let body: Record<string, any> = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const updateData: Partial<CameraRow> = {}
  if (body.name !== undefined) updateData.name = body.name
  if (body.location !== undefined) updateData.location = body.location
  if (body.resolution !== undefined) updateData.resolution = body.resolution
  if (body.status !== undefined) updateData.status = body.status

  if (Object.keys(updateData).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const cameraId = Number(id)
  if (!Number.isInteger(cameraId)) {
    return Response.json({ error: 'Invalid camera id' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('camera')
    .update(updateData)
    .eq('camera_id', cameraId)
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data })
}
