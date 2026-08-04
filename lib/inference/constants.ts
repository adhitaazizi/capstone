/**
 * Tunables for the spindle counting pipeline.
 *
 * All sampling logic lives server-side precisely so these can be changed by
 * editing `.env` and restarting only the `nextjs` container — Colab keeps
 * running and never needs a cell re-run.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    console.warn(`[inference] ${name}="${raw}" is not a number; using ${fallback}`)
    return fallback
  }
  return parsed
}

function str(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

/** Width of the sampling window. Should span at least one full spindle rotation:
 *  the whole max() premise is that some frame in the window catches the spindle
 *  with no toys hidden behind it. */
export const DETECTION_INTERVAL_MS = num('DETECTION_INTERVAL_MS', 2000)

/** Physical capacity of one spindle. Samples above this are implausible
 *  (double-detection, reflections) and are dropped, not clamped. */
export const MAX_HOTWHEELS = num('MAX_HOTWHEELS', 8)

/** Tolerance in spindle-relative units when testing containment. Absorbs toys
 *  whose centroid sits just outside the fitted spindle box. */
export const SPINDLE_BOUNDARY_MARGIN = num('SPINDLE_BOUNDARY_MARGIN', 0.15)

export const SPINDLE_MIN_CONFIDENCE = num('SPINDLE_MIN_CONFIDENCE', 0.5)
export const HOTWHEELS_MIN_CONFIDENCE = num('HOTWHEELS_MIN_CONFIDENCE', 0.35)

/** Consecutive spindle-absent intervals required to close a visit. */
export const SPINDLE_ABSENT_INTERVALS = num('SPINDLE_ABSENT_INTERVALS', 1)

/** Safety cap: force-close a visit that never ends, so a latched spindle
 *  detection cannot swallow every subsequent spindle. */
export const MAX_VISIT_INTERVALS = num('MAX_VISIT_INTERVALS', 15)

export const ENTRY_CAMERA_ID = str('ENTRY_CAMERA_ID', 'CAM-01')
export const EXIT_CAMERA_ID = str('EXIT_CAMERA_ID', 'CAM-02')

/** A pending entry with no exit after this long never reached the exit camera. */
export const SPINDLE_ORPHAN_TIMEOUT_MS = num('SPINDLE_ORPHAN_TIMEOUT_MS', 300_000)

/** Bounds the FIFO. Matches the deque(maxlen=50) of the previous reconciler. */
export const QUEUE_MAX_DEPTH = num('QUEUE_MAX_DEPTH', 50)

/** Shared secret for Colab → Next.js calls. The tunnel is publicly addressable,
 *  so an unset key means the ingest routes refuse to run. */
export const INFERENCE_API_KEY = process.env.INFERENCE_API_KEY ?? ''

/**
 * Class names from the RF-DETR checkpoint:
 *   ['hot-wheels-fd1tsjbuot2qusqjctck', 'hot wheels', 'spindle']
 * Index 0 is a Roboflow project-root artifact rather than a distinct class, so
 * both hot-wheels spellings are accepted. Matched by name, never by index —
 * retraining can reorder the class list.
 */
export const SPINDLE_CLASSES = new Set(['spindle'])
export const HOTWHEELS_CLASSES = new Set([
  'hot wheels',
  'hot-wheels',
  'hot-wheels-fd1tsjbuot2qusqjctck',
])

export function classify(name: string): 'spindle' | 'hotwheels' | 'unknown' {
  const key = name.trim().toLowerCase()
  if (SPINDLE_CLASSES.has(key)) return 'spindle'
  if (HOTWHEELS_CLASSES.has(key)) return 'hotwheels'
  return 'unknown'
}
