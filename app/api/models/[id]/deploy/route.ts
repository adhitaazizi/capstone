import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

export async function POST(
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
  const modelId = Number(id)
  if (!Number.isInteger(modelId)) {
    return Response.json({ error: 'Invalid model id' }, { status: 400 })
  }

  const supabase = createServerClient()

  await supabase.from('detection_model').update({ is_active: false }).neq('model_id', modelId)

  const { data, error } = await supabase
    .from('detection_model')
    .update({ is_active: true, deployed_at: new Date().toISOString() })
    .eq('model_id', modelId)
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data })
}
