/**
 * The process-wide pipeline singleton.
 *
 * Pinned to `globalThis` (the same trick the Prisma client uses) so that HMR in
 * `next dev` does not silently reset the FIFO queue between requests — a reset
 * mid-run would drop every pending pass and resynchronise the cameras to the
 * wrong offset, which is the kind of bug that produces plausible-looking but
 * wrong counts.
 *
 * IMPORTANT: this state lives in one Node process. Running more than one
 * `nextjs` replica would give each replica its own queue and break the FIFO
 * ordering the pairing depends on. Scaling out requires moving the pending
 * queue into Postgres first.
 */

import { AggregatorRegistry } from './aggregator'
import { supabasePassSink } from './persistence'
import { SpindleQueue } from './queue'
import { SessionRegistry } from './registry'
import type { CameraLiveState, PairedPass, RawFrame } from './types'

interface Pipeline {
  aggregators: AggregatorRegistry
  queue: SpindleQueue
  sessions: SessionRegistry
}

const GLOBAL_KEY = Symbol.for('spraycount.inference.pipeline')

function create(): Pipeline {
  return {
    aggregators: new AggregatorRegistry(),
    queue: new SpindleQueue({ sink: supabasePassSink }),
    sessions: new SessionRegistry(),
  }
}

function pipeline(): Pipeline {
  const store = globalThis as unknown as Record<symbol, Pipeline | undefined>
  if (!store[GLOBAL_KEY]) {
    store[GLOBAL_KEY] = create()
  }
  return store[GLOBAL_KEY]!
}

/** Ingest a batch of inferred frames and route any completed visits to the FIFO. */
export function ingestFrames(cameraId: string, frames: RawFrame[], now = Date.now()): void {
  const { aggregators, queue } = pipeline()
  for (const visit of aggregators.ingest(cameraId, frames, now)) {
    queue.handleVisit(visit, now)
  }
}

/**
 * Close any windows that elapsed since the last ingest. The dashboard poll
 * calls this so a visit still closes after Colab stops sending — without it a
 * visit would stay open indefinitely once the stream goes quiet.
 */
export function tick(now = Date.now()): void {
  const { aggregators, queue } = pipeline()
  for (const visit of aggregators.advanceAll(now)) {
    queue.handleVisit(visit, now)
  }
  queue.purge(now)
}

export function liveStates(): CameraLiveState[] {
  return pipeline().aggregators.liveStates()
}

export function recentPairs(limit?: number): PairedPass[] {
  return pipeline().queue.recentPairs(limit)
}

export function queueDepth(): number {
  return pipeline().queue.depth
}

export function sessions(): SessionRegistry {
  return pipeline().sessions
}
