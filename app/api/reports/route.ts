import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const role = (session.user as any).role
  if (!['supervisor', 'admin'].includes(role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const shiftLabel = searchParams.get('shift_label')

  const supabase = createServerClient()
  let query = supabase
    .from('production_session')
    .select('*')
    .order('start_time', { ascending: false })

  if (from) {
    query = query.gte('start_time', `${from}T00:00:00Z`)
  }
  if (to) {
    query = query.lte('start_time', `${to}T23:59:59.999Z`)
  }
  if (shiftLabel && shiftLabel !== 'all') {
    query = query.eq('shift_label', shiftLabel)
  }

  const { data: sessions, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rows = sessions ?? []
  const summary = {
    totalSessions: rows.length,
    totalSpindles: rows.reduce((sum, s) => sum + (s.total_spindles || 0), 0),
    totalMatched: rows.reduce((sum, s) => sum + (s.total_matched || 0), 0),
    totalMismatched: rows.reduce(
      (sum, s) => sum + (s.total_mismatched || 0),
      0
    ),
  }

  return Response.json({ sessions: rows, summary })
}
