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

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('production_session')
    .insert({
      shift_label: body.shift_label ?? null,
      operator_id: session.user.id,
    })
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ data }, { status: 201 })
}
