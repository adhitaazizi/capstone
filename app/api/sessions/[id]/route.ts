import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const supabase = createServerClient()

  const userRole = (session.user as any).role
  const userId = session.user.id

  const { data: sessionData } = await supabase
    .from('production_session')
    .select('operator_id')
    .eq('session_id', id)
    .single()

  if (userRole !== 'admin' && userRole !== 'supervisor' && sessionData?.operator_id !== userId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: passes, error: passesError } = await supabase
    .from('spindle_pass')
    .select('status')
    .eq('session_id', id)

  if (passesError) {
    return Response.json({ error: passesError.message }, { status: 500 })
  }

  const totalSpindles = passes?.length ?? 0
  const totalMatched = passes?.filter((p) => p.status === 'matched').length ?? 0
  const totalMismatched = passes?.filter((p) => p.status === 'mismatched').length ?? 0

  const { data, error } = await supabase
    .from('production_session')
    .update({
      end_time: new Date().toISOString(),
      total_spindles: totalSpindles,
      total_matched: totalMatched,
      total_mismatched: totalMismatched,
    })
    .eq('session_id', id)
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data })
}
