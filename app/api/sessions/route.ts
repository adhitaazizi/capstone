import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const active = searchParams.get('active')

  const supabase = createServerClient()
  let query = supabase
    .from('production_session')
    .select('*')
    .order('start_time', { ascending: false })

  if (active === 'true') {
    query = query.is('end_time', null)
  }

  const { data, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data })
}

function detectShift(now: Date): { shift_number: number; shift_label: string } {
  const h = now.getHours()
  const m = now.getMinutes()
  const totalMinutes = h * 60 + m

  if (totalMinutes < 8 * 60 + 40) {
    return { shift_number: 1, shift_label: 'Shift 1 (00:00–08:40)' }
  } else if (totalMinutes < 15 * 60 + 45) {
    return { shift_number: 2, shift_label: 'Shift 2 (08:40–15:45)' }
  } else {
    return { shift_number: 3, shift_label: 'Shift 3 (15:45–00:00)' }
  }
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, any> = {}
  try {
    body = await request.json()
  } catch {
    // allow empty body
  }

  const { shift_number, shift_label } = detectShift(new Date())

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('production_session')
    .insert({
      shift_number,
      shift_label,
      operator_id: session.user.id,
    })
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data }, { status: 201 })
}
