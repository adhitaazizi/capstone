/**
 * Interval windowing and visit segmentation.
 *
 * Two distinct units live here and they are easy to conflate:
 *
 *   - An **interval** (DETECTION_INTERVAL_MS) is the *sampling* unit. Within a
 *     window we take max(count), because the spindle rotates and only some
 *     frames catch it at the angle where no toy is hidden behind the post.
 *
 *   - A **visit** is the *event* unit — one contiguous run of spindle-present
 *     intervals, i.e. one physical spindle passing one camera. A spindle
 *     usually dwells for several intervals, so emitting one event per interval
 *     would enqueue the same spindle several times and desynchronise the
 *     cross-camera FIFO. Only visits are handed to the queue.
 *
 * Windows are anchored to server receipt time rather than to Colab's frame
 * timestamps, so clock skew between the Colab VM and this process cannot shift
 * a window boundary. Batches arrive every ~500 ms into a 2 s window, which is
 * ample resolution given the window's only job is to bound a max().
 */

import {
  DETECTION_INTERVAL_MS,
  MAX_HOTWHEELS,
  MAX_VISIT_INTERVALS,
  SPINDLE_ABSENT_INTERVALS,
} from './constants'
import { evaluateFrame } from './boundary'
import type {
  CameraLiveState,
  FrameSample,
  IntervalResult,
  NormalizedBox,
  RawFrame,
  SpindleVisit,
} from './types'

export interface AggregatorOptions {
  intervalMs?: number
  maxHotwheels?: number
  absentIntervals?: number
  maxVisitIntervals?: number
}

interface OpenVisit {
  counts: number[]
  startedAt: number
  endedAt: number
  intervalCount: number
  sampleCount: number
  spindleBox: NormalizedBox | null
  bestCount: number
}

export class CameraAggregator {
  readonly cameraId: string

  private readonly intervalMs: number
  private readonly maxHotwheels: number
  private readonly absentIntervals: number
  private readonly maxVisitIntervals: number

  private windowStart: number | null = null
  private windowSamples: FrameSample[] = []

  private visit: OpenVisit | null = null
  private absentRun = 0

  private lastInterval: IntervalResult | null = null
  private lastVisitCount: number | null = null
  private lastSampleAt: number | null = null
  private framesReceived = 0

  constructor(cameraId: string, opts: AggregatorOptions = {}) {
    this.cameraId = cameraId
    this.intervalMs = opts.intervalMs ?? DETECTION_INTERVAL_MS
    this.maxHotwheels = opts.maxHotwheels ?? MAX_HOTWHEELS
    this.absentIntervals = opts.absentIntervals ?? SPINDLE_ABSENT_INTERVALS
    this.maxVisitIntervals = opts.maxVisitIntervals ?? MAX_VISIT_INTERVALS
  }

  /** Feed a batch of inferred frames. Returns any visits completed as a result. */
  ingest(frames: RawFrame[], now: number): SpindleVisit[] {
    if (this.windowStart === null) this.windowStart = now

    const completed = this.advanceTo(now)

    for (const frame of frames) {
      this.windowSamples.push(evaluateFrame(frame))
      this.framesReceived += 1
    }
    if (frames.length > 0) this.lastSampleAt = now

    return completed
  }

  /**
   * Close any windows that have elapsed without new frames arriving. Callers
   * that only read state (the dashboard poll) still need this, otherwise a
   * visit stays open forever once Colab goes quiet.
   */
  advanceTo(now: number): SpindleVisit[] {
    if (this.windowStart === null) return []

    const completed: SpindleVisit[] = []
    // Bound the loop so a large clock jump or a long Colab outage cannot spin
    // through thousands of empty windows. Closing a handful of absent windows
    // is enough to close any open visit; past that the grid is re-anchored.
    const maxSteps = this.maxVisitIntervals + this.absentIntervals + 2
    let steps = 0

    while (now - this.windowStart >= this.intervalMs) {
      if (steps >= maxSteps) {
        this.windowStart = now
        this.windowSamples = []
        break
      }
      const result = this.closeWindow(this.windowStart)
      const visit = this.applyInterval(result)
      if (visit) completed.push(visit)

      this.windowStart += this.intervalMs
      steps += 1
    }

    return completed
  }

  private closeWindow(start: number): IntervalResult {
    const samples = this.windowSamples
    this.windowSamples = []

    const present = samples.filter((s) => s.spindlePresent)

    // A single frame's spindle detection can drop out mid-visit. Requiring only
    // a majority stops that flicker from splitting one visit into two.
    const spindlePresent = samples.length > 0 && present.length * 2 >= samples.length

    // Drop rather than clamp: clamping would let one bad frame pin the window
    // max at exactly MAX_HOTWHEELS, biasing every count upward.
    const plausible = present.filter((s) => s.count <= this.maxHotwheels)
    const droppedImplausible = present.length - plausible.length

    let count = 0
    let spindleBox: NormalizedBox | null = null
    for (const s of plausible) {
      if (s.count >= count) {
        count = s.count
        spindleBox = s.spindleBox
      }
    }
    if (spindleBox === null && present.length > 0) {
      spindleBox = present[present.length - 1].spindleBox
    }

    const result: IntervalResult = {
      cameraId: this.cameraId,
      windowStart: start,
      windowEnd: start + this.intervalMs,
      count: spindlePresent ? count : 0,
      spindlePresent,
      sampleCount: samples.length,
      droppedImplausible,
      spindleBox,
    }
    this.lastInterval = result
    return result
  }

  /** Fold one closed interval into the open visit. Returns a visit if it closed. */
  private applyInterval(result: IntervalResult): SpindleVisit | null {
    if (result.spindlePresent) {
      this.absentRun = 0
      if (!this.visit) {
        this.visit = {
          counts: [],
          startedAt: result.windowStart,
          endedAt: result.windowEnd,
          intervalCount: 0,
          sampleCount: 0,
          spindleBox: null,
          bestCount: -1,
        }
      }
      this.visit.counts.push(result.count)
      this.visit.intervalCount += 1
      this.visit.sampleCount += result.sampleCount
      this.visit.endedAt = result.windowEnd
      if (result.count > this.visit.bestCount) {
        this.visit.bestCount = result.count
        this.visit.spindleBox = result.spindleBox
      }

      // Safety valve: a detector that latches onto a spindle forever would
      // otherwise swallow every spindle behind it.
      if (this.visit.intervalCount >= this.maxVisitIntervals) {
        return this.closeVisit(true)
      }
      return null
    }

    this.absentRun += 1
    if (this.visit && this.absentRun >= this.absentIntervals) {
      return this.closeVisit(false)
    }
    return null
  }

  private closeVisit(truncated: boolean): SpindleVisit | null {
    const open = this.visit
    this.visit = null
    if (!open) return null

    const count = open.counts.length > 0 ? Math.max(...open.counts) : 0
    this.lastVisitCount = count

    return {
      cameraId: this.cameraId,
      count,
      startedAt: open.startedAt,
      endedAt: open.endedAt,
      intervalCount: open.intervalCount,
      sampleCount: open.sampleCount,
      spindleBox: open.spindleBox,
      truncated,
    }
  }

  liveState(): CameraLiveState {
    return {
      cameraId: this.cameraId,
      spindlePresent: this.visit !== null,
      intervalCount: this.lastInterval?.count ?? 0,
      lastVisitCount: this.lastVisitCount,
      lastSampleAt: this.lastSampleAt,
      framesReceived: this.framesReceived,
    }
  }
}

/** Holds one aggregator per camera, created on first sight of that camera. */
export class AggregatorRegistry {
  private readonly cameras = new Map<string, CameraAggregator>()

  constructor(private readonly opts: AggregatorOptions = {}) {}

  private get(cameraId: string): CameraAggregator {
    let agg = this.cameras.get(cameraId)
    if (!agg) {
      agg = new CameraAggregator(cameraId, this.opts)
      this.cameras.set(cameraId, agg)
    }
    return agg
  }

  ingest(cameraId: string, frames: RawFrame[], now: number): SpindleVisit[] {
    return this.get(cameraId).ingest(frames, now)
  }

  /** Close overdue windows on every known camera. */
  advanceAll(now: number): SpindleVisit[] {
    const visits: SpindleVisit[] = []
    for (const agg of this.cameras.values()) {
      visits.push(...agg.advanceTo(now))
    }
    return visits
  }

  liveStates(): CameraLiveState[] {
    return [...this.cameras.values()].map((a) => a.liveState())
  }
}
