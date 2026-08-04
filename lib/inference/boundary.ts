/**
 * Per-frame spindle-boundary filtering.
 *
 * The core problem this solves: the spindle's bounding box is not the same on
 * every sample. It shifts and changes size as the spindle rotates and as the
 * detector's fit varies frame to frame, so a fixed pixel region cannot be used
 * to decide which toys "belong" to the spindle.
 *
 * The fix is to never compare boxes across samples at all. Each hot-wheels
 * centroid is mapped into the coordinate space of *that frame's own* spindle
 * box, where the spindle always occupies exactly [0,1] x [0,1]. A spindle that
 * appears larger, smaller, or shifted between samples therefore produces
 * identical containment decisions for toys in the same relative position.
 */

import {
  HOTWHEELS_MIN_CONFIDENCE,
  SPINDLE_BOUNDARY_MARGIN,
  SPINDLE_MIN_CONFIDENCE,
  classify,
} from './constants'
import type { FrameSample, NormalizedBox, RawDetection, RawFrame } from './types'

/** Boxes narrower than this (in frame-normalized units) cannot be normalized
 *  against without the division blowing up. */
const MIN_SPINDLE_EXTENT = 1e-3

export interface BoundaryOptions {
  margin?: number
  spindleMinConfidence?: number
  hotwheelsMinConfidence?: number
}

function area(box: NormalizedBox): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}

function centroid(box: NormalizedBox): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
}

/**
 * Pick the spindle the toys should be measured against. Ranked by
 * `confidence x area` rather than confidence alone: when a background spindle
 * from the next station clips the frame edge, it can score a high confidence on
 * a small box, and counting the foreground spindle's toys against it would be
 * wrong. Area breaks that tie toward the spindle actually under the camera.
 */
function primarySpindle(spindles: RawDetection[]): RawDetection | null {
  let best: RawDetection | null = null
  let bestScore = -1
  for (const s of spindles) {
    const score = s.conf * area(s.box)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }
  return best
}

/**
 * Map a point into spindle-relative unit space and test containment.
 * Exported so the normalization invariant can be tested directly.
 */
export function isInsideSpindle(
  point: [number, number],
  spindleBox: NormalizedBox,
  margin: number = SPINDLE_BOUNDARY_MARGIN
): boolean {
  const [sx1, sy1, sx2, sy2] = spindleBox
  const width = sx2 - sx1
  const height = sy2 - sy1
  if (width < MIN_SPINDLE_EXTENT || height < MIN_SPINDLE_EXTENT) return false

  const u = (point[0] - sx1) / width
  const v = (point[1] - sy1) / height
  return u >= -margin && u <= 1 + margin && v >= -margin && v <= 1 + margin
}

/**
 * Reduce one frame of raw detections to a countable sample.
 *
 * Returns `spindlePresent: false` with `count: 0` when no spindle is visible.
 * That is not the same as a spindle holding zero toys, and the aggregator
 * relies on the distinction to segment visits.
 */
export function evaluateFrame(frame: RawFrame, opts: BoundaryOptions = {}): FrameSample {
  const margin = opts.margin ?? SPINDLE_BOUNDARY_MARGIN
  const spindleMin = opts.spindleMinConfidence ?? SPINDLE_MIN_CONFIDENCE
  const hotwheelsMin = opts.hotwheelsMinConfidence ?? HOTWHEELS_MIN_CONFIDENCE

  const spindles: RawDetection[] = []
  const hotwheels: RawDetection[] = []

  for (const det of frame.detections ?? []) {
    const kind = classify(det.cls)
    if (kind === 'spindle') {
      if (det.conf >= spindleMin) spindles.push(det)
    } else if (kind === 'hotwheels') {
      if (det.conf >= hotwheelsMin) hotwheels.push(det)
    }
  }

  const spindle = primarySpindle(spindles)
  if (!spindle) {
    return {
      ts: frame.ts,
      count: 0,
      spindlePresent: false,
      spindleBox: null,
      avgConfidence: 0,
      rejected: 0,
    }
  }

  const box = spindle.box
  if (box[2] - box[0] < MIN_SPINDLE_EXTENT || box[3] - box[1] < MIN_SPINDLE_EXTENT) {
    // A degenerate box would make every containment test meaningless; treat it
    // as no spindle rather than silently counting nothing.
    return {
      ts: frame.ts,
      count: 0,
      spindlePresent: false,
      spindleBox: null,
      avgConfidence: 0,
      rejected: 0,
    }
  }

  let count = 0
  let rejected = 0
  let confSum = 0

  for (const hw of hotwheels) {
    if (isInsideSpindle(centroid(hw.box), box, margin)) {
      count += 1
      confSum += hw.conf
    } else {
      rejected += 1
    }
  }

  return {
    ts: frame.ts,
    count,
    spindlePresent: true,
    spindleBox: box,
    avgConfidence: count > 0 ? confSum / count : 0,
    rejected,
  }
}
