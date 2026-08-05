/**
 * Pipeline settings — the DB-backed replacement for the tunables that used
 * to live in `.env` (see lib/inference/constants.ts and
 * supabase/migrations/012_system_settings.sql). Admin-only, same
 * session + role check as app/api/users/route.ts.
 */

import { headers } from 'next/headers'

import { auth } from '@/lib/auth'
import { CAMERA_IDS } from '@/lib/cameras'
import { PIPELINE_SETTINGS, validateSettingValue } from '@/lib/inference/constants'
import { refreshSettingsNow } from '@/lib/inference/settings-store'
import { createServerClient } from '@/lib/supabase/server'

async function requireAdmin() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  if ((session.user as any).role !== 'admin') {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { session }
}

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const supabase = createServerClient()
  const { data, error: dbError } = await supabase
    .from('system_settings')
    .select('key, value, description, updated_at')

  if (dbError) {
    return Response.json({ error: dbError.message }, { status: 500 })
  }

  const byKey = new Map((data ?? []).map((row) => [row.key, row]))
  const settings = PIPELINE_SETTINGS.map((meta) => {
    const row = byKey.get(meta.key)
    return {
      ...meta,
      value: row?.value ?? '',
      updatedAt: row?.updated_at ?? null,
    }
  })

  return Response.json({ settings })
}

export async function PATCH(request: Request) {
  const { error, session } = await requireAdmin()
  if (error) return error

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const updates = body.updates
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    return Response.json(
      { error: 'updates must be an object mapping setting key to new value' },
      { status: 400 }
    )
  }

  const validKeys = new Set(PIPELINE_SETTINGS.map((s) => s.key))
  const rows: { key: string; value: string; updated_by: string }[] = []
  const fieldErrors: Record<string, string> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (!validKeys.has(key as any)) {
      return Response.json({ error: `Unknown setting key: ${key}` }, { status: 400 })
    }
    const strValue = String(value)
    const err = validateSettingValue(key as any, strValue, CAMERA_IDS)
    if (err) fieldErrors[key] = err
    rows.push({ key, value: strValue, updated_by: session!.user.id })
  }

  if (rows.length === 0) {
    return Response.json({ error: 'updates is empty' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Cross-field: a spindle can't be paired if entry and exit resolve to the
  // same camera — check against whichever side of the pair isn't part of
  // this PATCH too, not just the two fields in isolation.
  const touchesCameraIds = 'ENTRY_CAMERA_ID' in updates || 'EXIT_CAMERA_ID' in updates
  if (touchesCameraIds && Object.keys(fieldErrors).length === 0) {
    const { data: cameraRows } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['ENTRY_CAMERA_ID', 'EXIT_CAMERA_ID'])
    const current = Object.fromEntries((cameraRows ?? []).map((r) => [r.key, r.value]))
    const updatesMap = updates as Record<string, unknown>
    const entry = String(updatesMap.ENTRY_CAMERA_ID ?? current.ENTRY_CAMERA_ID ?? '').trim()
    const exit = String(updatesMap.EXIT_CAMERA_ID ?? current.EXIT_CAMERA_ID ?? '').trim()
    if (entry && exit && entry === exit) {
      fieldErrors.ENTRY_CAMERA_ID = 'Must differ from the exit camera.'
      fieldErrors.EXIT_CAMERA_ID = 'Must differ from the entry camera.'
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return Response.json({ error: 'Validation failed', fieldErrors }, { status: 400 })
  }

  const { error: dbError } = await supabase
    .from('system_settings')
    .upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })))

  if (dbError) {
    return Response.json({ error: dbError.message }, { status: 500 })
  }

  // Visible on the very next request instead of waiting for the poll interval.
  await refreshSettingsNow()

  return Response.json({ status: 'ok', updated: rows.map((r) => r.key) })
}
