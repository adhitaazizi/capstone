/**
 * Shared types for the spindle counting pipeline.
 *
 * Data flows: Colab (raw detections) → boundary → aggregator → queue → Supabase.
 * Every stage below the route handler is a pure function over injected values,
 * so the whole pipeline is testable without cameras, a GPU, or Colab.
 */

/** Bounding box in frame-normalized coordinates: [x1, y1, x2, y2], each 0..1. */
export type NormalizedBox = [number, number, number, number]

/** One detection as emitted by Colab. Coordinates are frame-normalized. */
export interface RawDetection {
  cls: string
  conf: number
  box: NormalizedBox
}

/** One inferred frame as emitted by Colab. `ts` is epoch milliseconds. */
export interface RawFrame {
  ts: number
  inferenceMs?: number
  detections: RawDetection[]
}

/** Result of applying the spindle-boundary filter to a single frame. */
export interface FrameSample {
  ts: number
  /** Hot wheels whose centroid falls inside the normalized spindle boundary. */
  count: number
  spindlePresent: boolean
  /** The primary spindle box, in frame-normalized coordinates. */
  spindleBox: NormalizedBox | null
  /** Mean confidence across the in-boundary hot wheels. */
  avgConfidence: number
  /** Hot wheels detected but rejected as outside the boundary. */
  rejected: number
}

/** One closed DETECTION_INTERVAL window for one camera. */
export interface IntervalResult {
  cameraId: string
  windowStart: number
  windowEnd: number
  /** max() across plausible in-window samples, already MAX_HOTWHEELS-filtered. */
  count: number
  spindlePresent: boolean
  sampleCount: number
  /** Samples dropped for exceeding MAX_HOTWHEELS. Surfaced for tuning. */
  droppedImplausible: number
  spindleBox: NormalizedBox | null
}

/**
 * One contiguous run of spindle-present intervals — a single physical spindle
 * observed by a single camera. This, not the interval, is the unit that gets
 * paired across cameras.
 */
export interface SpindleVisit {
  cameraId: string
  count: number
  startedAt: number
  endedAt: number
  intervalCount: number
  sampleCount: number
  spindleBox: NormalizedBox | null
  /** True when the visit was force-closed by MAX_VISIT_INTERVALS. */
  truncated: boolean
}

/** A CAM-01 visit awaiting its CAM-02 counterpart. */
export interface PendingPass {
  spindlePassId: string
  /**
   * Position in the run, counted from 1 — the number an operator can say out
   * loud. `spindlePassId` is a UUID: correct for joining rows, useless for
   * "which spindle is on the line right now". Assigned at the entry camera and
   * carried to the exit camera, so both observations of one physical spindle
   * share it. In-process and monotonic, so it restarts with `nextjs`.
   */
  spindleNumber: number
  entryCount: number
  entryTime: number
  visit: SpindleVisit
}

/** A completed entry/exit pairing. */
export interface PairedPass {
  spindlePassId: string
  /** The entry-side spindle number, carried through unchanged. */
  spindleNumber: number
  entryCount: number
  exitCount: number
  /** Signed: positive means the exit camera saw more than the entry camera. */
  mismatchDelta: number
  status: 'matched' | 'mismatched'
  entryTime: number
  exitTime: number
}

export interface CameraLiveState {
  cameraId: string
  spindlePresent: boolean
  /** Count from the most recently closed interval. */
  intervalCount: number
  /** Count from the most recently closed visit. */
  lastVisitCount: number | null
  lastSampleAt: number | null
  framesReceived: number
}
