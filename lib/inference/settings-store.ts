/**
 * Polls `system_settings` and applies changes to the running process — see
 * lib/inference/constants.ts's module docstring for which tunables this
 * actually reaches live vs. only after a restart.
 *
 * Pinned to `globalThis`, the same trick lib/inference/pipeline.ts uses, so
 * Next.js dev's hot-module-reload cannot spawn a second polling interval.
 */

import { createServerClient } from '@/lib/supabase/server'
import { applySettingsFromDb } from '@/lib/inference/constants'

const POLL_INTERVAL_MS = 5000
const KEY = Symbol.for('spraycount.settingsStore')

interface SettingsStore {
  timer: ReturnType<typeof setInterval> | null
  started: boolean
}

function store(): SettingsStore {
  const g = globalThis as unknown as Record<symbol, SettingsStore | undefined>
  if (!g[KEY]) {
    g[KEY] = { timer: null, started: false }
  }
  return g[KEY]!
}

export async function fetchAllSettings(): Promise<Record<string, string>> {
  const supabase = createServerClient()
  const { data, error } = await supabase.from('system_settings').select('key, value')
  if (error) {
    console.warn(`[settings-store] fetch failed: ${error.message}`)
    return {}
  }
  const rows: Record<string, string> = {}
  for (const row of data ?? []) rows[row.key] = row.value
  return rows
}

async function poll(): Promise<void> {
  const rows = await fetchAllSettings()
  if (Object.keys(rows).length > 0) applySettingsFromDb(rows)
}

/** Idempotent — safe to call from every route that touches the pipeline;
 *  only the first call in this process actually starts the timer. */
export function ensureSettingsPolling(): void {
  const s = store()
  if (s.started) return
  s.started = true
  void poll()
  s.timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
  // Node keeps the process alive for a ref'd timer; this one should never be
  // the reason a script hangs (e.g. a one-off migration/test runner).
  s.timer.unref?.()
}

/** Called by app/api/settings/route.ts's PATCH so an edit is visible on the
 *  very next request instead of waiting up to POLL_INTERVAL_MS. */
export async function refreshSettingsNow(): Promise<void> {
  await poll()
}
