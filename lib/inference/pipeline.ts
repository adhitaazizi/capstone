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
import { ConsumerRegistry } from './consumers'
import { supabasePassSink } from './persistence'
import { SpindleQueue } from './queue'
import { SessionRegistry } from './registry'
import { ensureSettingsPolling } from './settings-store'
import type { CameraLiveState, PairedPass, RawFrame } from './types'

interface Pipeline {
  aggregators: AggregatorRegistry
  queue: SpindleQueue
  sessions: SessionRegistry
  consumers: ConsumerRegistry
}

const GLOBAL_KEY = Symbol.for('spraycount.inference.pipeline')

function create(): Pipeline {
  // Best-effort: starts the DB poll so later restarts pick up settings
  // edits, but a truly cold process still constructs these singletons from
  // process.env/hardcoded defaults this one time — the first poll is async
  // and cannot be awaited from a synchronous constructor without making
  // every call site in this file async. See constants.ts's module docstring.
  ensureSettingsPolling()
  return {
    aggregators: new AggregatorRegistry(),
    queue: new SpindleQueue({ sink: supabasePassSink }),
    sessions: new SessionRegistry(),
    consumers: new ConsumerRegistry(),
  }
}

function pipeline(): Pipeline {
  const store = globalThis as unknown as Record<symbol, Pipeline | undefined>
  if (!store[GLOBAL_KEY]) {
    store[GLOBAL_KEY] = create()
  }
  return store[GLOBAL_KEY]!
}

/**
 * Whether this camera's detections are allowed to reach the aggregator.
 *
 * Two conditions, and the second is the load-bearing one:
 *
 *   1. a browser is decoding annotated frames for this camera right now
 *      (lib/inference/consumers.ts), and
 *   2. the session it is decoding is the processed session registered for this
 *      camera *now*.
 *
 * Without (2) the gate would be trivially satisfiable by a stale viewer: the
 * GPU worker republishes on every restart, and a tile still holding the
 * previous annotated session would otherwise vouch for detections coming from
 * a completely different one.
 */
export function isCounting(cameraId: string, now = Date.now()): boolean {
  const { consumers, sessions } = pipeline()
  const consumer = consumers.get(cameraId, now)
  if (!consumer) return false
  const processed = sessions.liveProcessed(now)[cameraId]
  return processed !== undefined && processed.sessionId === consumer.sessionId
}

/** Cameras whose detections are currently being counted. */
export function countingCameras(now = Date.now()): string[] {
  return pipeline()
    .consumers.active(now)
    .filter((cameraId) => isCounting(cameraId, now))
}

export interface IngestResult {
  accepted: number
  /** True when the batch was discarded because nobody is watching this camera. */
  gated: boolean
}

/**
 * Ingest a batch of inferred frames and route any completed visits to the FIFO.
 *
 * Gated frames are dropped rather than buffered, and the camera's in-flight
 * windowing state is reset with them — a visit must never span a pause (see
 * CameraAggregator.reset). The worker is not asked to stop: it keeps inferring
 * and gets a 200 with `gated: true`, so resuming is instant once a viewer
 * comes back rather than requiring the worker to be restarted.
 */
export function ingestFrames(
  cameraId: string,
  frames: RawFrame[],
  now = Date.now()
): IngestResult {
  const { aggregators, queue } = pipeline()

  if (!isCounting(cameraId, now)) {
    aggregators.reset(cameraId)
    return { accepted: 0, gated: true }
  }

  for (const visit of aggregators.ingest(cameraId, frames, now)) {
    queue.handleVisit(visit, now)
  }
  return { accepted: frames.length, gated: false }
}

/**
 * Close any windows that elapsed since the last ingest. The dashboard poll
 * calls this so a visit still closes after Colab stops sending — without it a
 * visit would stay open indefinitely once the stream goes quiet.
 *
 * The gate is re-checked here too, not only in `ingestFrames`. A camera whose
 * viewer goes away stops POSTing nothing — it stops being ingested at all — so
 * without this pass its open visit would sit untouched until the next batch,
 * then be closed by `advanceAll` as though the pause had never happened.
 */
export function tick(now = Date.now()): void {
  const { aggregators, queue } = pipeline()

  for (const cameraId of aggregators.cameraIds()) {
    if (!isCounting(cameraId, now)) aggregators.reset(cameraId)
  }

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

/** The spindle between the cameras right now, or null when the line is clear. */
export function currentSpindleNumber(): number | null {
  return pipeline().queue.currentSpindleNumber
}

export function sessions(): SessionRegistry {
  return pipeline().sessions
}

export function consumers(): ConsumerRegistry {
  return pipeline().consumers
}
