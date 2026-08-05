/**
 * Tunables for the spindle counting pipeline.
 *
 * Source of truth is the `system_settings` DB table (see
 * supabase/migrations/012_system_settings.sql and
 * lib/inference/settings-store.ts, which polls it), edited from
 * /settings/pipeline. Every export below is a `let`, not a `const`, so that
 * lib/inference/settings-store.ts can reassign it in place after a poll —
 * boundary.ts/aggregator.ts/queue.ts reference these by name inside function
 * bodies or default parameters, both of which re-read a live ES module
 * binding on every call, so no change is needed in those files.
 *
 * That said, NOT every export here is safe to change mid-process:
 *   - SPINDLE_BOUNDARY_MARGIN, SPINDLE_MIN_CONFIDENCE, HOTWHEELS_MIN_CONFIDENCE
 *     and the INFERENCE_* group are read fresh on every call/request — these
 *     apply within one settings-store poll interval, no restart.
 *   - DETECTION_INTERVAL_MS, MAX_HOTWHEELS, SPINDLE_ABSENT_INTERVALS,
 *     MAX_VISIT_INTERVALS, ENTRY_CAMERA_ID, EXIT_CAMERA_ID,
 *     SPINDLE_ORPHAN_TIMEOUT_MS and QUEUE_MAX_DEPTH are snapshotted once into
 *     instance fields when lib/inference/pipeline.ts's globalThis-pinned
 *     AggregatorRegistry/SpindleQueue singletons are constructed. Reassigning
 *     these while passes are mid-flight (a window mid-count, an entry
 *     pending its exit) risks corrupting the FIFO pairing — see
 *     PIPELINE_SETTINGS' `appliesLive` flag, surfaced in the settings UI as
 *     "takes effect after restarting nextjs".
 *
 * process.env is still consulted as the *cold-start* default, before the
 * first DB poll resolves — see num()/str() below.
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
export let DETECTION_INTERVAL_MS = num('DETECTION_INTERVAL_MS', 2000)

/** Physical capacity of one spindle. Samples above this are implausible
 *  (double-detection, reflections) and are dropped, not clamped. */
export let MAX_HOTWHEELS = num('MAX_HOTWHEELS', 8)

/** Tolerance in spindle-relative units when testing containment. Absorbs toys
 *  whose centroid sits just outside the fitted spindle box. */
export let SPINDLE_BOUNDARY_MARGIN = num('SPINDLE_BOUNDARY_MARGIN', 0.15)

export let SPINDLE_MIN_CONFIDENCE = num('SPINDLE_MIN_CONFIDENCE', 0.5)
export let HOTWHEELS_MIN_CONFIDENCE = num('HOTWHEELS_MIN_CONFIDENCE', 0.35)

/** Consecutive spindle-absent intervals required to close a visit. */
export let SPINDLE_ABSENT_INTERVALS = num('SPINDLE_ABSENT_INTERVALS', 1)

/** Safety cap: force-close a visit that never ends, so a latched spindle
 *  detection cannot swallow every subsequent spindle. */
export let MAX_VISIT_INTERVALS = num('MAX_VISIT_INTERVALS', 15)

export let ENTRY_CAMERA_ID = str('ENTRY_CAMERA_ID', 'CAM-01')
export let EXIT_CAMERA_ID = str('EXIT_CAMERA_ID', 'CAM-02')

/** A pending entry with no exit after this long never reached the exit camera. */
export let SPINDLE_ORPHAN_TIMEOUT_MS = num('SPINDLE_ORPHAN_TIMEOUT_MS', 300_000)

/** Bounds the FIFO. Matches the deque(maxlen=50) of the previous reconciler. */
export let QUEUE_MAX_DEPTH = num('QUEUE_MAX_DEPTH', 50)

/** Shared secret for Colab → Next.js calls. The tunnel is publicly addressable,
 *  so an unset key means the ingest routes refuse to run. Stays env-only — a
 *  secret, not a tunable, so it never enters system_settings. */
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

/**
 * RF-DETR-facing tunables — how the GPU inference worker interprets a camera
 * stream, not how Next.js counts what it emits. Served to the worker via
 * GET /api/inference/source's `inference` block (see that route), read fresh
 * on every request — so these apply as soon as settings-store.ts's next poll
 * lands, no restart, even when the worker runs on a separate machine (e.g. a
 * RunPod pod).
 */
export let INFERENCE_CONFIDENCE = num('INFERENCE_CONFIDENCE', 0.35)
export let INFERENCE_MAX_DETECTIONS = num('INFERENCE_MAX_DETECTIONS', 100)
/** Comma-separated checkpoint class names to keep; empty keeps every class. */
export let INFERENCE_TARGET_CLASS_NAMES = str('INFERENCE_TARGET_CLASS_NAMES', '')
/** "HEIGHT,WIDTH"; empty uses the checkpoint's own resolution. */
export let INFERENCE_SHAPE = str('INFERENCE_SHAPE', '')

export function classify(name: string): 'spindle' | 'hotwheels' | 'unknown' {
  const key = name.trim().toLowerCase()
  if (SPINDLE_CLASSES.has(key)) return 'spindle'
  if (HOTWHEELS_CLASSES.has(key)) return 'hotwheels'
  return 'unknown'
}

/** Display + edit metadata for /settings/pipeline and app/api/settings.
 *  `appliesLive: false` means the value is snapshotted into the
 *  AggregatorRegistry/SpindleQueue singletons at construction — see the
 *  module docstring — and only takes effect after the nextjs container
 *  restarts (clearing the globalThis-pinned pipeline).
 *
 *  `required: false` exists on exactly two entries (the RF-DETR class filter
 *  and inference shape) — every other setting must have a value; there is no
 *  sensible "unset" state for a sampling window or a camera id. `isCameraId`
 *  entries are validated against lib/cameras.ts's CAMERAS — see
 *  validateSettingValue below — rather than accepting an arbitrary string,
 *  since ENTRY_CAMERA_ID/EXIT_CAMERA_ID drive the FIFO pairing and a typo'd
 *  id that doesn't match anything actually publishing would silently orphan
 *  every visit. */
export const PIPELINE_SETTINGS = [
  {
    key: 'DETECTION_INTERVAL_MS',
    label: 'Detection interval (ms)',
    type: 'number',
    required: true,
    min: 100,
    step: 100,
    appliesLive: false,
    description:
      'Sampling window width. Must span at least one full spindle rotation.',
  },
  {
    key: 'MAX_HOTWHEELS',
    label: 'Max Hot Wheels per spindle',
    type: 'number',
    required: true,
    min: 1,
    step: 1,
    appliesLive: false,
    description:
      'Physical capacity of one spindle. Samples above this are dropped as implausible, not clamped.',
  },
  {
    key: 'SPINDLE_BOUNDARY_MARGIN',
    label: 'Spindle boundary margin',
    type: 'number',
    required: true,
    min: 0,
    max: 1,
    step: 0.01,
    appliesLive: true,
    description: 'Containment tolerance in spindle-relative units.',
  },
  {
    key: 'SPINDLE_MIN_CONFIDENCE',
    label: 'Spindle min confidence',
    type: 'number',
    required: true,
    min: 0,
    max: 1,
    step: 0.01,
    appliesLive: true,
    description: 'Minimum confidence to accept a spindle detection.',
  },
  {
    key: 'HOTWHEELS_MIN_CONFIDENCE',
    label: 'Hot Wheels min confidence',
    type: 'number',
    required: true,
    min: 0,
    max: 1,
    step: 0.01,
    appliesLive: true,
    description: 'Minimum confidence to accept a hot-wheels detection.',
  },
  {
    key: 'SPINDLE_ABSENT_INTERVALS',
    label: 'Spindle-absent intervals to close a visit',
    type: 'number',
    required: true,
    min: 1,
    step: 1,
    appliesLive: false,
    description:
      'Consecutive spindle-absent intervals required to close a visit. Raise if flicker splits one spindle into two visits.',
  },
  {
    key: 'MAX_VISIT_INTERVALS',
    label: 'Max visit intervals',
    type: 'number',
    required: true,
    min: 1,
    step: 1,
    appliesLive: false,
    description: "Safety cap: force-closes a visit that never ends.",
  },
  {
    key: 'ENTRY_CAMERA_ID',
    label: 'Entry camera',
    type: 'string',
    required: true,
    isCameraId: true,
    appliesLive: false,
    description:
      'Camera a spindle reaches first. The FIFO pairing depends on this order — picked from the same list as /cameras, not free text.',
  },
  {
    key: 'EXIT_CAMERA_ID',
    label: 'Exit camera',
    type: 'string',
    required: true,
    isCameraId: true,
    appliesLive: false,
    description: 'Camera a spindle reaches second. Must differ from the entry camera.',
  },
  {
    key: 'SPINDLE_ORPHAN_TIMEOUT_MS',
    label: 'Orphan entry timeout (ms)',
    type: 'number',
    required: true,
    min: 1000,
    step: 1000,
    appliesLive: false,
    description: 'A pending entry with no matching exit after this long is abandoned.',
  },
  {
    key: 'QUEUE_MAX_DEPTH',
    label: 'FIFO queue max depth',
    type: 'number',
    required: true,
    min: 1,
    step: 1,
    appliesLive: false,
    description: 'Bounds the FIFO cross-camera pairing queue.',
  },
  {
    key: 'INFERENCE_CONFIDENCE',
    label: 'RF-DETR confidence threshold',
    type: 'number',
    required: true,
    min: 0,
    max: 1,
    step: 0.01,
    appliesLive: true,
    description: 'Served to the GPU inference worker via GET /api/inference/source.',
  },
  {
    key: 'INFERENCE_MAX_DETECTIONS',
    label: 'RF-DETR max detections / frame',
    type: 'number',
    required: true,
    min: 1,
    step: 1,
    appliesLive: true,
    description: 'Served to the GPU inference worker via GET /api/inference/source.',
  },
  {
    key: 'INFERENCE_TARGET_CLASS_NAMES',
    label: 'RF-DETR class filter',
    type: 'string',
    required: false,
    appliesLive: true,
    description: 'Comma-separated checkpoint class names to keep; empty keeps every class.',
  },
  {
    key: 'INFERENCE_SHAPE',
    label: 'RF-DETR inference shape',
    type: 'string',
    required: false,
    appliesLive: true,
    description: '"HEIGHT,WIDTH" fed to the model; empty uses the checkpoint default.',
  },
] as const

export type PipelineSettingKey = (typeof PIPELINE_SETTINGS)[number]['key']

/** Single source of truth for validity, shared by app/api/settings/route.ts
 *  (server-side, authoritative) and the /settings/pipeline form
 *  (client-side, for instant feedback) — see the ENTRY/EXIT_CAMERA_ID note
 *  above for why camera ids are checked against lib/cameras.ts rather than
 *  accepted as-is. Returns an error message, or null if `raw` is valid. */
export function validateSettingValue(
  key: PipelineSettingKey,
  raw: string,
  knownCameraIds: readonly string[]
): string | null {
  const meta = PIPELINE_SETTINGS.find((s) => s.key === key)
  if (!meta) return `Unknown setting: ${key}`

  const trimmed = raw.trim()
  if (trimmed === '') {
    return meta.required ? 'Required.' : null
  }

  if ('isCameraId' in meta && meta.isCameraId) {
    if (!knownCameraIds.includes(trimmed)) {
      return `Must be one of: ${knownCameraIds.join(', ')}`
    }
    return null
  }

  if (key === 'INFERENCE_SHAPE') {
    const parts = trimmed.split(',').map((p) => p.trim())
    if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p) && Number(p) > 0)) {
      return 'Must be "HEIGHT,WIDTH" (two positive integers), or empty.'
    }
    return null
  }

  if (meta.type === 'number') {
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return 'Must be a number.'
    if ('min' in meta && meta.min !== undefined && parsed < meta.min) {
      return `Must be at least ${meta.min}.`
    }
    if ('max' in meta && meta.max !== undefined && parsed > meta.max) {
      return `Must be at most ${meta.max}.`
    }
  }

  return null
}

/** Applied by settings-store.ts after each DB poll. Reassigns the live
 *  bindings above in place — see the module docstring for which ones take
 *  effect immediately vs. after a restart. Unknown/missing keys are left
 *  untouched; unparseable numbers keep their current value. */
export function applySettingsFromDb(rows: Record<string, string>): void {
  const n = (key: PipelineSettingKey, current: number): number => {
    const raw = rows[key]
    if (raw === undefined) return current
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : current
  }
  const s = (key: PipelineSettingKey, current: string): string =>
    rows[key] !== undefined ? rows[key] : current

  DETECTION_INTERVAL_MS = n('DETECTION_INTERVAL_MS', DETECTION_INTERVAL_MS)
  MAX_HOTWHEELS = n('MAX_HOTWHEELS', MAX_HOTWHEELS)
  SPINDLE_BOUNDARY_MARGIN = n('SPINDLE_BOUNDARY_MARGIN', SPINDLE_BOUNDARY_MARGIN)
  SPINDLE_MIN_CONFIDENCE = n('SPINDLE_MIN_CONFIDENCE', SPINDLE_MIN_CONFIDENCE)
  HOTWHEELS_MIN_CONFIDENCE = n('HOTWHEELS_MIN_CONFIDENCE', HOTWHEELS_MIN_CONFIDENCE)
  SPINDLE_ABSENT_INTERVALS = n('SPINDLE_ABSENT_INTERVALS', SPINDLE_ABSENT_INTERVALS)
  MAX_VISIT_INTERVALS = n('MAX_VISIT_INTERVALS', MAX_VISIT_INTERVALS)
  ENTRY_CAMERA_ID = s('ENTRY_CAMERA_ID', ENTRY_CAMERA_ID)
  EXIT_CAMERA_ID = s('EXIT_CAMERA_ID', EXIT_CAMERA_ID)
  SPINDLE_ORPHAN_TIMEOUT_MS = n('SPINDLE_ORPHAN_TIMEOUT_MS', SPINDLE_ORPHAN_TIMEOUT_MS)
  QUEUE_MAX_DEPTH = n('QUEUE_MAX_DEPTH', QUEUE_MAX_DEPTH)
  INFERENCE_CONFIDENCE = n('INFERENCE_CONFIDENCE', INFERENCE_CONFIDENCE)
  INFERENCE_MAX_DETECTIONS = n('INFERENCE_MAX_DETECTIONS', INFERENCE_MAX_DETECTIONS)
  INFERENCE_TARGET_CLASS_NAMES = s(
    'INFERENCE_TARGET_CLASS_NAMES',
    INFERENCE_TARGET_CLASS_NAMES
  )
  INFERENCE_SHAPE = s('INFERENCE_SHAPE', INFERENCE_SHAPE)
}
