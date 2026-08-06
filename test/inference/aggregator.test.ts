import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CameraAggregator } from '../../lib/inference/aggregator'
import type { NormalizedBox, RawDetection, RawFrame } from '../../lib/inference/types'

const INTERVAL = 2000
const SPINDLE: NormalizedBox = [0.1, 0.1, 0.9, 0.9]

function toy(index: number): RawDetection {
  // Lay toys out along the middle of the spindle so all are comfortably inside.
  const u = 0.1 + index * 0.05
  const cx = 0.1 + u * 0.8
  return { cls: 'hot wheels', conf: 0.9, box: [cx - 0.01, 0.49, cx + 0.01, 0.51] }
}

/** A frame showing the spindle holding `count` toys. */
function present(count: number, ts = 0): RawFrame {
  return {
    ts,
    detections: [
      { cls: 'spindle', conf: 0.9, box: SPINDLE },
      ...Array.from({ length: count }, (_, i) => toy(i)),
    ],
  }
}

/** A frame with nothing in it — the gap between spindles. */
function absent(ts = 0): RawFrame {
  return { ts, detections: [] }
}

function makeAggregator(overrides = {}) {
  return new CameraAggregator('CAM-01', {
    intervalMs: INTERVAL,
    maxHotwheels: 8,
    absentIntervals: 1,
    maxVisitIntervals: 15,
    ...overrides,
  })
}

describe('interval windowing', () => {
  it('takes max() across the window, not the last or the mean', () => {
    const agg = makeAggregator()
    // The spindle rotates within the window; only some frames catch it with no
    // toy hidden behind the post.
    agg.ingest([present(3), present(6), present(5), present(4)], 0)
    agg.ingest([absent()], INTERVAL)

    // The visit closes one interval after the spindle disappears.
    const visits = agg.ingest([absent()], INTERVAL * 2)
    assert.equal(visits.length, 1)
    assert.equal(visits[0].count, 6)
  })

  it('drops implausible samples instead of clamping them to MAX_HOTWHEELS', () => {
    const agg = makeAggregator({ maxHotwheels: 8 })
    // Clamping 11 would yield exactly 8 and quietly bias the count upward on
    // the strength of one bad frame. Dropping it yields the real maximum.
    agg.ingest([present(6), present(11), present(7)], 0)
    agg.ingest([absent()], INTERVAL)
    const visits = agg.ingest([absent()], INTERVAL * 2)

    assert.equal(visits.length, 1)
    assert.equal(visits[0].count, 7)
  })

  it('survives a single dropped spindle detection mid-window', () => {
    const agg = makeAggregator()
    // Two of three frames still see the spindle, so the majority vote keeps the
    // window present and the visit does not split.
    agg.ingest([present(4), absent(), present(5)], 0)
    agg.ingest([present(5)], INTERVAL)
    agg.ingest([absent()], INTERVAL * 2)
    const visits = agg.ingest([absent()], INTERVAL * 3)

    assert.equal(visits.length, 1)
    assert.equal(visits[0].intervalCount, 2)
    assert.equal(visits[0].count, 5)
  })
})

describe('visit segmentation', () => {
  it('emits one visit per contiguous run, not one per interval', () => {
    const agg = makeAggregator()
    const emitted = []

    // present, present, absent, present, absent → exactly two visits.
    emitted.push(...agg.ingest([present(4)], 0))
    emitted.push(...agg.ingest([present(6)], INTERVAL))
    emitted.push(...agg.ingest([absent()], INTERVAL * 2))
    emitted.push(...agg.ingest([present(3)], INTERVAL * 3))
    emitted.push(...agg.ingest([absent()], INTERVAL * 4))
    emitted.push(...agg.ingest([absent()], INTERVAL * 5))

    assert.equal(emitted.length, 2, 'a dwelling spindle must produce exactly one visit')
    assert.equal(emitted[0].count, 6, 'first visit takes the max across its intervals')
    assert.equal(emitted[0].intervalCount, 2)
    assert.equal(emitted[1].count, 3)
    assert.equal(emitted[1].intervalCount, 1)
  })

  it('emits nothing while no spindle is in view', () => {
    const agg = makeAggregator()
    let emitted = 0
    for (let i = 0; i < 6; i += 1) {
      emitted += agg.ingest([absent()], INTERVAL * i).length
    }
    assert.equal(emitted, 0)
  })

  it('force-closes a latched visit so it cannot swallow later spindles', () => {
    const agg = makeAggregator({ maxVisitIntervals: 3 })
    const emitted = []
    for (let i = 0; i < 5; i += 1) {
      emitted.push(...agg.ingest([present(5)], INTERVAL * i))
    }

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].truncated, true)
    assert.equal(emitted[0].intervalCount, 3)
  })

  it('waits SPINDLE_ABSENT_INTERVALS before closing when configured higher', () => {
    const agg = makeAggregator({ absentIntervals: 2 })
    const emitted = []

    emitted.push(...agg.ingest([present(4)], 0))
    emitted.push(...agg.ingest([absent()], INTERVAL)) // closes a present window
    emitted.push(...agg.ingest([present(7)], INTERVAL * 2)) // one absent window only
    emitted.push(...agg.ingest([absent()], INTERVAL * 3))
    assert.equal(emitted.length, 0, 'a single absent interval must not close the visit')

    emitted.push(...agg.ingest([absent()], INTERVAL * 4))
    emitted.push(...agg.ingest([absent()], INTERVAL * 5))
    assert.equal(emitted.length, 1)
    // The flicker did not split the spindle into two visits.
    assert.equal(emitted[0].count, 7)
  })
})

describe('advanceTo', () => {
  it('closes an open visit after the stream goes quiet', () => {
    const agg = makeAggregator()
    agg.ingest([present(5)], 0)
    agg.ingest([present(5)], INTERVAL)

    // Colab stops sending. Without a tick the visit would stay open forever.
    const visits = agg.advanceTo(INTERVAL * 4)
    assert.equal(visits.length, 1)
    assert.equal(visits[0].count, 5)
  })

  it('does not spin through thousands of windows after a long outage', () => {
    const agg = makeAggregator()
    agg.ingest([present(5)], 0)

    const started = Date.now()
    const visits = agg.advanceTo(INTERVAL * 100_000)
    assert.ok(Date.now() - started < 1000, 'window advance must be bounded')
    assert.equal(visits.length, 1)
  })
})

/**
 * reset() is what the counting gate calls when the annotated stream stops
 * being consumed (lib/inference/consumers.ts). The invariant it protects is
 * the one the FIFO pairing depends on: a visit must never span the pause.
 */
describe('reset', () => {
  it('abandons an open visit instead of closing it later', () => {
    const agg = makeAggregator()
    agg.ingest([present(5)], 0)
    agg.ingest([present(5)], INTERVAL)

    agg.reset()

    // Without reset this would emit the half-observed visit, which the queue
    // would then pair against the other camera's complete one.
    assert.deepEqual(agg.advanceTo(INTERVAL * 4), [])
  })

  it('does not merge observations from either side of a pause', () => {
    const agg = makeAggregator()
    agg.ingest([present(3)], 0)
    agg.reset()

    // A different spindle arrives after the pause. Its visit must start clean:
    // carrying the pre-pause window over would let one spindle's count leak
    // into the next and shift every subsequent pairing.
    agg.ingest([present(6)], INTERVAL * 10)
    const visits = agg.advanceTo(INTERVAL * 13)

    assert.equal(visits.length, 1)
    assert.equal(visits[0].count, 6)
    assert.equal(visits[0].startedAt, INTERVAL * 10)
  })

  it('clears the live count so a paused camera does not look active', () => {
    const agg = makeAggregator()
    agg.ingest([present(4)], 0)
    agg.advanceTo(INTERVAL * 4)

    agg.reset()

    const state = agg.liveState()
    assert.equal(state.spindlePresent, false)
    assert.equal(state.intervalCount, 0)
    assert.equal(state.lastVisitCount, null)
    // Cumulative diagnostic — deliberately survives a reset.
    assert.equal(state.framesReceived, 1)
  })
})
