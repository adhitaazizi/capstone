import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import type { UserRow } from '@/lib/supabase/types'
import { hashPassword } from 'better-auth/crypto'

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

  const updateData: Partial<UserRow> = {}
  const newPassword = typeof body.password === 'string' ? body.password : ''

  if (newPassword) {
    if (newPassword.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    const { data: target, error: targetError } = await createServerClient()
      .from('user')
      .select('role')
      .eq('id', id)
      .single()
    if (targetError || !target) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }
    if (target.role === 'admin') {
      return Response.json(
        { error: 'Administrators can only change their own password.' },
        { status: 403 }
      )
    }
  }
  if (body.role !== undefined) {
    if (!['operator', 'supervisor', 'admin'].includes(body.role)) {
      return Response.json({ error: 'Invalid role' }, { status: 400 })
    }
    updateData.role = body.role
  }
  if (body.is_active !== undefined) {
    updateData.is_active = Boolean(body.is_active)
  }

  if (Object.keys(updateData).length === 0 && !newPassword) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const supabase = createServerClient()
  let data: UserRow | null = null
  let error = null
  if (Object.keys(updateData).length > 0) {
    const result = await supabase
      .from('user')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()
    data = result.data
    error = result.error
  } else {
    const result = await supabase.from('user').select().eq('id', id).single()
    data = result.data
    error = result.error
  }

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  if (newPassword) {
    const password = await hashPassword(newPassword)
    const { data: account, error: accountError } = await supabase
      .from('account')
      .update({ password, updated_at: new Date().toISOString() })
      .eq('user_id', id)
      .eq('provider_id', 'credential')
      .select('id')
      .single()
    if (accountError || !account) {
      return Response.json(
        { error: accountError?.message || 'Credential account not found' },
        { status: 500 }
      )
    }
    await supabase.from('session').delete().eq('user_id', id)
  }

  return Response.json({ data })
}
