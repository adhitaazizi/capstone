/**
 * FIFO cross-camera pairing.
 *
 * This is the piece that gives both cameras' observations of one physical
 * spindle the *same* `spindle_pass_id`. It works because the line guarantees
 * ordering: a spindle always reaches the entry camera before the exit camera,
 * and spindles never overtake one another. So the n-th visit at the exit camera
 * is necessarily the n-th visit at the entry camera, and a plain queue is
 * enough — no appearance matching, no homography, no timestamp correlation.
 *
 * The ordering guarantee is exactly why visit segmentation (see aggregator.ts)
 * has to be correct: one physical spindle must produce exactly one visit per
 * camera. Emitting two visits at the entry camera for one spindle would shift
 * every subsequent pairing by one and corrupt all downstream counts silently.
 */

import {
  ENTRY_CAMERA_ID,
  EXIT_CAMERA_ID,
  QUEUE_MAX_DEPTH,
  SPINDLE_ORPHAN_TIMEOUT_MS,
} from './constants'
import type { PairedPass, PendingPass, SpindleVisit } from './types'

/** Persistence hooks. Injected so the queue can be tested without a database. */
export interface PassSink {
  onEntry?(pass: PendingPass): void | Promise<void>
  onPaired?(pair: PairedPass, exitVisit: SpindleVisit): void | Promise<void>
  /** An exit visit with nothing queued — the entry camera missed this spindle. */
  onOrphanExit?(visit: SpindleVisit): void | Promise<void>
  /** A queued entry that never reached the exit camera. */
  onOrphanEntry?(pass: PendingPass, reason: 'timeout' | 'overflow'): void | Promise<void>
}

export interface QueueOptions {
  entryCameraId?: string
  exitCameraId?: string
  maxDepth?: number
  orphanTimeoutMs?: number
  sink?: PassSink
  newId?: () => string
}

export class SpindleQueue {
  private readonly entryCameraId: string
  private readonly exitCameraId: string
  private readonly maxDepth: number
  private readonly orphanTimeoutMs: number
  private readonly sink: PassSink
  private readonly newId: () => string

  private readonly pending: PendingPass[] = []
  private readonly recent: PairedPass[] = []

  /**
   * Sink calls are chained rather than awaited inline: the queue's own state
   * must mutate in strict arrival order, but the DB writes it triggers are
   * async. Chaining keeps those writes in the same order without letting a slow
   * write reorder the queue itself.
   */
  private tail: Promise<void> = Promise.resolve()

  constructor(opts: QueueOptions = {}) {
    this.entryCameraId = opts.entryCameraId ?? ENTRY_CAMERA_ID
    this.exitCameraId = opts.exitCameraId ?? EXIT_CAMERA_ID
    this.maxDepth = opts.maxDepth ?? QUEUE_MAX_DEPTH
    this.orphanTimeoutMs = opts.orphanTimeoutMs ?? SPINDLE_ORPHAN_TIMEOUT_MS
    this.sink = opts.sink ?? {}
    this.newId = opts.newId ?? (() => crypto.randomUUID())
  }

  handleVisit(visit: SpindleVisit, now: number): void {
    this.purge(now)

    if (visit.cameraId === this.entryCameraId) {
      this.pushEntry(visit)
    } else if (visit.cameraId === this.exitCameraId) {
      this.popExit(visit)
    } else {
      console.warn(
        `[inference] visit from unknown camera "${visit.cameraId}" ignored ` +
          `(expected "${this.entryCameraId}" or "${this.exitCameraId}")`
      )
    }
  }

  private pushEntry(visit: SpindleVisit): void {
    const pass: PendingPass = {
      spindlePassId: this.newId(),
      entryCount: visit.count,
      entryTime: visit.endedAt,
      visit,
    }
    this.pending.push(pass)

    // Unbounded growth would mean the exit camera has been down for a long
    // time; dropping the oldest is the least-bad option but must be loud.
    while (this.pending.length > this.maxDepth) {
      const dropped = this.pending.shift()!
      console.warn(
        `[inference] queue depth exceeded ${this.maxDepth}; dropping pass ` +
          `${dropped.spindlePassId} (entry ${dropped.entryCount}). Is ` +
          `${this.exitCameraId} producing visits?`
      )
      this.run(() => this.sink.onOrphanEntry?.(dropped, 'overflow'))
    }

    this.run(() => this.sink.onEntry?.(pass))
  }

  private popExit(visit: SpindleVisit): void {
    const pass = this.pending.shift()
    if (!pass) {
      console.warn(
        `[inference] exit visit (count ${visit.count}) with an empty queue — ` +
          `${this.entryCameraId} missed this spindle`
      )
      this.run(() => this.sink.onOrphanExit?.(visit))
      return
    }

    const mismatchDelta = visit.count - pass.entryCount
    const pair: PairedPass = {
      spindlePassId: pass.spindlePassId,
      entryCount: pass.entryCount,
      exitCount: visit.count,
      // Signed, not absolute: the sign says whether toys were gained or lost,
      // which is the actionable part for the line operator.
      mismatchDelta,
      status: mismatchDelta === 0 ? 'matched' : 'mismatched',
      entryTime: pass.entryTime,
      exitTime: visit.endedAt,
    }

    this.recent.unshift(pair)
    if (this.recent.length > 20) this.recent.pop()

    this.run(() => this.sink.onPaired?.(pair, visit))
  }

  /** Drop entries that can no longer be paired. Safe to call at any time. */
  purge(now: number): void {
    while (
      this.pending.length > 0 &&
      now - this.pending[0].entryTime > this.orphanTimeoutMs
    ) {
      const stale = this.pending.shift()!
      console.warn(
        `[inference] pass ${stale.spindlePassId} timed out after ` +
          `${this.orphanTimeoutMs} ms without an exit observation`
      )
      this.run(() => this.sink.onOrphanEntry?.(stale, 'timeout'))
    }
  }

  private run(fn: () => void | Promise<void>): void {
    this.tail = this.tail.then(fn).catch((err) => {
      console.error('[inference] pass sink failed:', err)
    })
  }

  /** Resolves once every sink call issued so far has settled. Used by tests. */
  drain(): Promise<void> {
    return this.tail
  }

  get depth(): number {
    return this.pending.length
  }

  recentPairs(limit = 10): PairedPass[] {
    return this.recent.slice(0, limit)
  }
}
