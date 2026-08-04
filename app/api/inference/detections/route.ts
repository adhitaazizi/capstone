/**
 * Colab → Next.js ingest for raw per-frame detections.
 *
 * Colab does inference only; every sampling decision (spindle-boundary
 * filtering, interval max, MAX_HOTWHEELS plausibility, visit segmentation,
 * FIFO pairing) happens behind `ingestFrames`.
 */

import { checkInferenceKey } from '@/lib/inference/auth'
import { ingestFrames } from '@/lib/inference/pipeline'
import type { NormalizedBox, RawDetection, RawFrame } from '@/lib/inference/types'

// Module state must live in one long-lived Node process, and the response must
// never be cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseBox(value: unknown): NormalizedBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const nums = value.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

function parseDetections(value: unknown): RawDetection[] {
  if (!Array.isArray(value)) return []
  const out: RawDetection[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const box = parseBox(raw.box)
    if (!box) continue
    const conf = Number(raw.conf)
    out.push({
      cls: String(raw.cls ?? ''),
      conf: Number.isFinite(conf) ? conf : 0,
      box,
    })
  }
  return out
}

export async function POST(request: Request) {
  const denied = checkInferenceKey(request)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const cameraId = String(body.cameraId ?? '').trim()
  if (!cameraId) {
    return Response.json({ error: 'cameraId is required' }, { status: 400 })
  }

  if (!Array.isArray(body.frames)) {
    return Response.json({ error: 'frames must be an array' }, { status: 400 })
  }

  const frames: RawFrame[] = []
  for (const item of body.frames) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const ts = Number(raw.ts)
    frames.push({
      // Colab timestamps are kept for diagnostics only — windows are anchored
      // to server receipt time so clock skew cannot move a boundary.
      ts: Number.isFinite(ts) ? ts : Date.now(),
      inferenceMs: Number(raw.inferenceMs) || undefined,
      detections: parseDetections(raw.detections),
    })
  }

  ingestFrames(cameraId, frames)

  return Response.json({ status: 'ok', accepted: frames.length })
}
