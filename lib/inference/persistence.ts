/**
 * Supabase-backed implementation of the queue's PassSink.
 *
 * Writes `spindle_pass` (one row per physical spindle) and `detection_event`
 * (one row per camera observation). The two cameras' rows for a spindle share
 * a `spindle_pass_id` — that shared key is the whole point of the FIFO.
 */

import { createServerClient } from '@/lib/supabase/server'
import type { PassSink } from './queue'
import type { PairedPass, PendingPass, SpindleVisit } from './types'

const SESSION_CACHE_MS = 30_000

let cachedSessionId: string | null = null
let cachedSessionAt = 0

/**
 * The active production session, or null when the operator has not started
 * one. Cached briefly so a per-visit write does not add a round trip.
 */
async function activeSessionId(): Promise<string | null> {
  const now = Date.now()
  // Only a positive result is cached. Caching "no active session" would mean
  // that starting a shift is ignored for up to 30 s, silently dropping the
  // first spindles of the shift — and a re-check costs one cheap query.
  if (cachedSessionId !== null && now - cachedSessionAt < SESSION_CACHE_MS) {
    return cachedSessionId
  }

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('production_session')
    .select('session_id')
    .is('end_time', null)
    .order('start_time', { ascending: false })
    .limit(1)

  if (error) {
    console.error('[inference] failed to resolve active session:', error.message)
    return null
  }

  cachedSessionId = data?.[0]?.session_id ?? null
  cachedSessionAt = now
  return cachedSessionId
}

/** Forces the next write to re-resolve the session. Called when one starts/ends. */
export function invalidateSessionCache(): void {
  cachedSessionId = null
  cachedSessionAt = 0
}

/** Human-readable label for the dashboard's "Toy Number" column. Derived from
 *  the pass id so it survives restarts without needing a counter. */
function toyNumber(spindlePassId: string): string {
  return `SP-${spindlePassId.slice(0, 8).toUpperCase()}`
}

async function insertDetectionEvent(
  spindlePassId: string | null,
  visit: SpindleVisit
): Promise<void> {
  const supabase = createServerClient()
  const { error } = await supabase.from('detection_event').insert({
    // Denormalized deliberately: it lets a shift's raw observations be queried
    // without joining through spindle_pass, which an orphaned observation has
    // no row in anyway.
    session_id: await activeSessionId(),
    spindle_pass_id: spindlePassId,
    camera_code: visit.cameraId,
    frame_timestamp: new Date(visit.endedAt).toISOString(),
    raw_count: visit.count,
    interval_count: visit.intervalCount,
    sample_count: visit.sampleCount,
    spindle_box: visit.spindleBox,
    window_start: new Date(visit.startedAt).toISOString(),
    window_end: new Date(visit.endedAt).toISOString(),
  })

  if (error) {
    console.error(
      `[inference] detection_event insert failed for ${visit.cameraId}:`,
      error.message
    )
  }
}

export const supabasePassSink: PassSink = {
  async onEntry(pass: PendingPass) {
    const sessionId = await activeSessionId()
    if (!sessionId) {
      // No session running: keep serving live counts, but do not write rows
      // that would not belong to any shift.
      return
    }

    const supabase = createServerClient()
    const { error } = await supabase.from('spindle_pass').insert({
      pass_id: pass.spindlePassId,
      session_id: sessionId,
      toy_number: toyNumber(pass.spindlePassId),
      entry_count: pass.entryCount,
      entry_time: new Date(pass.entryTime).toISOString(),
      status: 'in_progress',
    })

    if (error) {
      console.error('[inference] spindle_pass insert failed:', error.message)
      return
    }

    await insertDetectionEvent(pass.spindlePassId, pass.visit)
  },

  async onPaired(pair: PairedPass, exitVisit: SpindleVisit) {
    const supabase = createServerClient()
    const { error } = await supabase
      .from('spindle_pass')
      .update({
        exit_count: pair.exitCount,
        exit_time: new Date(pair.exitTime).toISOString(),
        mismatch_delta: pair.mismatchDelta,
        status: pair.status,
      })
      .eq('pass_id', pair.spindlePassId)

    if (error) {
      console.error('[inference] spindle_pass update failed:', error.message)
    }

    // Written even if the update failed: the observation happened, and the
    // detection_event row is the audit trail for reconciling later.
    await insertDetectionEvent(pair.spindlePassId, exitVisit)
  },

  async onOrphanExit(visit: SpindleVisit) {
    // Migration 008 dropped NOT NULL on spindle_pass_id precisely so an
    // unpairable observation can still be recorded.
    await insertDetectionEvent(null, visit)
  },

  async onOrphanEntry(pass: PendingPass, reason) {
    const supabase = createServerClient()
    const { error } = await supabase
      .from('spindle_pass')
      .update({ status: 'mismatched' })
      .eq('pass_id', pass.spindlePassId)
      .eq('status', 'in_progress')

    if (error) {
      console.error(
        `[inference] failed to mark pass ${pass.spindlePassId} orphaned (${reason}):`,
        error.message
      )
    }
  },
}
