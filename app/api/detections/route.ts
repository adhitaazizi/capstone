import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  let body: {
    camera_code: string
    count: number
    confidence_avg: number
    bboxes: object[]
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Resolve camera_id from camera_code
  const { data: camera } = await supabase
    .from('camera')
    .select('camera_id')
    .eq('camera_code', body.camera_code)
    .single()

  // Resolve active model_id
  const { data: model } = await supabase
    .from('detection_model')
    .select('model_id')
    .eq('is_active', true)
    .single()

  if (!camera || !model) {
    return NextResponse.json(
      { error: 'camera or model not found — run seed migrations first' },
      { status: 422 }
    )
  }

  const { error } = await supabase.from('detection_event').insert({
    camera_id: camera.camera_id,
    model_id: model.model_id,
    spindle_pass_id: null,       // browser detections are not tied to a spindle pass
    frame_timestamp: new Date().toISOString(),
    raw_count: body.count,
    confidence_avg: body.confidence_avg,
    bboxes: body.bboxes,
  })

  if (error) {
    console.error('[detections] insert failed', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200)

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('detection_event')
    .select('event_id, camera_id, frame_timestamp, raw_count, confidence_avg, bboxes')
    .is('spindle_pass_id', null)   // only browser detections
    .order('frame_timestamp', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
