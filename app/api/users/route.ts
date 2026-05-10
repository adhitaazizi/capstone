import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if ((session.user as any).role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('user')
    .select('id, name, email, role, is_active, created_at')
    .order('created_at', { ascending: false })

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
  if ((session.user as any).role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, any> = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { email, password, name, role } = body
  if (!email || !password || !name) {
    return Response.json(
      { error: 'Missing required fields: email, password, name' },
      { status: 400 }
    )
  }

  try {
    const result = await (auth.api as any).signUpEmail({
      body: {
        email,
        password,
        name,
      },
    })

    if (!result || !result.user) {
      return Response.json({ error: 'Failed to create user' }, { status: 500 })
    }

    const supabase = createServerClient()
    if (role && ['operator', 'supervisor', 'admin'].includes(role)) {
      const { error: updateError } = await supabase
        .from('user')
        .update({ role })
        .eq('id', result.user.id)

      if (updateError) {
        return Response.json(
          { error: `User created but failed to set role: ${updateError.message}` },
          { status: 500 }
        )
      }
    }

    return Response.json({ data: result.user }, { status: 201 })
  } catch (err: any) {
    return Response.json(
      { error: err.message || 'Failed to create user' },
      { status: 500 }
    )
  }
}
