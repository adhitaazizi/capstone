/**
 * Stands in for Colab so the whole counting pipeline can be tested without a
 * GPU, cameras, Cloudflare, or a tunnel.
 *
 * Drives two synthetic spindles past both cameras by POSTing detections to
 * /api/inference/detections in real time, then reads the resulting rows back
 * out of Supabase and checks the pairing.
 *
 *   npx tsx scripts/simulate-spindles.ts
 *
 * Requires: the app running (npm run dev), and INFERENCE_API_KEY,
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 */

import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (m) env[m[1]] = m[2].trim()
    }
  } catch {
    // fall through to process.env
  }
  return { ...env, ...process.env } as Record<string, string>
}

const env = loadEnv()
const BASE_URL = env.SIM_BASE_URL || 'http://localhost:3000'
const API_KEY = env.INFERENCE_API_KEY || ''
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || ''
const INTERVAL_MS = Number(env.DETECTION_INTERVAL_MS || 2000)
const ENTRY_CAM = env.ENTRY_CAMERA_ID || 'CAM-01'
const EXIT_CAM = env.EXIT_CAMERA_ID || 'CAM-02'

/** Sends per interval. More sends = more frames inside one max() window. */
const SENDS_PER_INTERVAL = 4

// ---------------------------------------------------------------------------
// Synthetic frames
// ---------------------------------------------------------------------------

const SPINDLE_BOX: [number, number, number, number] = [0.15, 0.1, 0.85, 0.95]

/**
 * A frame holding `count` toys inside the spindle. The spindle box is jittered
 * every frame, which is the whole point: containment must not depend on the
 * box being stable, only on where a toy sits relative to it.
 */
function frame(count: number, extraOutside = 0) {
  const jitter = (Math.random() - 0.5) * 0.06
  const [x1, y1, x2, y2] = SPINDLE_BOX
  const sx1 = x1 + jitter
  const sx2 = x2 + jitter
  const w = sx2 - sx1
  const h = y2 - y1

  const detections: { cls: string; conf: number; box: number[] }[] = [
    { cls: 'spindle', conf: 0.92, box: [sx1, y1, sx2, y2] },
  ]

  for (let i = 0; i < count; i += 1) {
    const u = 0.15 + (i / Math.max(1, count)) * 0.7
    const cx = sx1 + u * w
    const cy = y1 + 0.5 * h
    detections.push({
      cls: 'hot wheels',
      conf: 0.85 + Math.random() * 0.1,
      box: [cx - 0.03, cy - 0.05, cx + 0.03, cy + 0.05],
    })
  }

  // Toys on the neighbouring spindle — must be excluded by the boundary filter.
  for (let i = 0; i < extraOutside; i += 1) {
    detections.push({
      cls: 'hot wheels',
      conf: 0.88,
      box: [sx2 + 0.3 + i * 0.05, 0.45, sx2 + 0.34 + i * 0.05, 0.55],
    })
  }

  return { ts: Date.now(), inferenceMs: 35 + Math.random() * 15, detections }
}

function emptyFrame() {
  return { ts: Date.now(), inferenceMs: 30, detections: [] }
}

// ---------------------------------------------------------------------------
// Timeline — one entry per DETECTION_INTERVAL. null means "no spindle".
// ---------------------------------------------------------------------------

interface Phase {
  /** Per-frame counts sent within this interval; max() of these is the result. */
  counts: number[] | null
  label: string
}

function busy(counts: number[], label: string): Phase {
  return { counts, label }
}
const gap: Phase = { counts: null, label: 'gap' }

// Spindle A holds 6 (max of 4,6,5 — plus one implausible 11 that must be
// dropped, not clamped). Spindle B holds 3 at entry but only 2 at exit.
const TIMELINE: Record<string, Phase[]> = {
  [ENTRY_CAM]: [
    busy([4, 6, 11, 5], 'A'),
    busy([5, 6, 4, 6], 'A'),
    gap,
    gap,
    busy([3, 3, 2, 3], 'B'),
    busy([2, 3, 3, 3], 'B'),
    gap,
    gap,
    gap,
  ],
  [EXIT_CAM]: [
    gap,
    gap,
    busy([5, 6, 6, 4], "A'"),
    busy([6, 5, 6, 6], "A'"),
    gap,
    gap,
    busy([2, 2, 1, 2], "B'"),
    busy([2, 1, 2, 2], "B'"),
    gap,
  ],
}

const EXPECTED = [
  { spindle: 'A', entry: 6, exit: 6, delta: 0, status: 'matched' },
  { spindle: 'B', entry: 3, exit: 2, delta: -1, status: 'mismatched' },
]

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postFrames(cameraId: string, frames: unknown[]) {
  const resp = await fetch(`${BASE_URL}/api/inference/detections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inference-key': API_KEY },
    body: JSON.stringify({ cameraId, frames }),
  })
  if (!resp.ok) {
    throw new Error(`POST /api/inference/detections → ${resp.status} ${await resp.text()}`)
  }
}

async function supabase(path: string, init: RequestInit = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`Supabase ${path} → ${resp.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function ensureSession(): Promise<string | null> {
  const active = await supabase('production_session?end_time=is.null&select=session_id&limit=1')
  if (active.length > 0) {
    console.log(`Using the active production session ${active[0].session_id}`)
    return active[0].session_id
  }
  const created = await supabase('production_session', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ shift_number: 2, shift_label: 'Simulator run' }),
  })
  console.log(`Started production session ${created[0].session_id}`)
  return created[0].session_id
}

async function main() {
  for (const [name, value] of Object.entries({ API_KEY, SUPABASE_URL, SERVICE_KEY })) {
    if (!value) throw new Error(`${name} is not set — check .env`)
  }

  const health = await fetch(`${BASE_URL}/api/inference/source`, {
    headers: { 'x-inference-key': API_KEY },
  }).catch(() => null)
  if (!health) throw new Error(`Cannot reach ${BASE_URL} — is the app running?`)
  if (health.status === 401) throw new Error('INFERENCE_API_KEY rejected by the app')
  if (health.status === 503) throw new Error('The app has no INFERENCE_API_KEY configured')

  const sessionId = await ensureSession()
  const startedAt = new Date().toISOString()

  const phaseCount = Math.max(...Object.values(TIMELINE).map((t) => t.length))
  console.log(
    `\nDriving 2 spindles past ${ENTRY_CAM} → ${EXIT_CAM} ` +
      `(${phaseCount} intervals x ${INTERVAL_MS} ms ≈ ${(phaseCount * INTERVAL_MS) / 1000}s)\n`
  )

  for (let i = 0; i < phaseCount; i += 1) {
    const labels: string[] = []
    for (let s = 0; s < SENDS_PER_INTERVAL; s += 1) {
      for (const cameraId of [ENTRY_CAM, EXIT_CAM]) {
        const phase = TIMELINE[cameraId][i] ?? gap
        if (phase.counts === null) {
          await postFrames(cameraId, [emptyFrame()])
        } else {
          const n = phase.counts[s % phase.counts.length]
          await postFrames(cameraId, [frame(n, 2)])
        }
      }
      await sleep(INTERVAL_MS / SENDS_PER_INTERVAL)
    }
    for (const cameraId of [ENTRY_CAM, EXIT_CAM]) {
      const phase = TIMELINE[cameraId][i] ?? gap
      labels.push(`${cameraId}=${phase.counts ? phase.label : '·'}`)
    }
    console.log(`  interval ${String(i + 1).padStart(2)}  ${labels.join('  ')}`)
  }

  // Let the trailing window close and the async DB writes settle.
  console.log('\nWaiting for the final visit to close…')
  await sleep(INTERVAL_MS + 1500)
  await fetch(`${BASE_URL}/api/inference/live`).catch(() => null) // nudges tick()
  await sleep(1500)

  // -------------------------------------------------------------------------
  // Verify
  // -------------------------------------------------------------------------
  const passes = await supabase(
    `spindle_pass?session_id=eq.${sessionId}&entry_time=gte.${startedAt}` +
      `&select=pass_id,toy_number,entry_count,exit_count,mismatch_delta,status&order=entry_time.asc`
  )

  console.log('\n=== spindle_pass ===')
  if (passes.length === 0) console.log('  (none)')
  for (const p of passes) {
    console.log(
      `  ${p.toy_number}  entry=${p.entry_count}  exit=${p.exit_count}  ` +
        `delta=${p.mismatch_delta}  ${p.status}`
    )
  }

  console.log('\n=== detection_event, grouped by spindle_pass_id ===')
  let sharedIdOk = true
  for (const p of passes) {
    const events = await supabase(
      `detection_event?spindle_pass_id=eq.${p.pass_id}` +
        `&select=camera_code,raw_count,interval_count,sample_count&order=camera_code.asc`
    )
    const cams = events.map((e: { camera_code: string }) => e.camera_code)
    console.log(
      `  ${p.pass_id.slice(0, 8)}…  ${events
        .map(
          (e: { camera_code: string; raw_count: number; sample_count: number }) =>
            `${e.camera_code}:${e.raw_count} (${e.sample_count} frames)`
        )
        .join('  ')}`
    )
    if (!cams.includes(ENTRY_CAM) || !cams.includes(EXIT_CAM)) sharedIdOk = false
  }

  // -------------------------------------------------------------------------
  console.log('\n=== result ===')
  let failures = 0
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
    if (!ok) failures += 1
  }

  check(passes.length === EXPECTED.length, `${EXPECTED.length} spindle passes recorded (got ${passes.length})`)
  EXPECTED.forEach((want, i) => {
    const got = passes[i]
    if (!got) {
      check(false, `spindle ${want.spindle} recorded`)
      return
    }
    check(
      got.entry_count === want.entry,
      `spindle ${want.spindle} entry = ${want.entry} (max() over the window, 11 dropped as implausible) — got ${got.entry_count}`
    )
    check(got.exit_count === want.exit, `spindle ${want.spindle} exit = ${want.exit} — got ${got.exit_count}`)
    check(
      got.mismatch_delta === want.delta && got.status === want.status,
      `spindle ${want.spindle} delta = ${want.delta}, ${want.status} — got ${got.mismatch_delta}, ${got.status}`
    )
  })
  check(sharedIdOk, 'both cameras share one spindle_pass_id per spindle')

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nSimulator failed:', err.message)
  process.exit(1)
})
