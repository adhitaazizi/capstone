import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SpindleQueue, type PassSink } from '../../lib/inference/queue'
import type { PairedPass, PendingPass, SpindleVisit } from '../../lib/inference/types'

function visit(cameraId: string, count: number, endedAt: number): SpindleVisit {
  return {
    cameraId,
    count,
    startedAt: endedAt - 2000,
    endedAt,
    intervalCount: 1,
    sampleCount: 10,
    spindleBox: [0.1, 0.1, 0.9, 0.9],
    truncated: false,
  }
}

interface Recorded {
  entries: PendingPass[]
  paired: { pair: PairedPass; visit: SpindleVisit }[]
  orphanExits: SpindleVisit[]
  orphanEntries: { pass: PendingPass; reason: string }[]
}

function recorder(): { sink: PassSink; log: Recorded } {
  const log: Recorded = { entries: [], paired: [], orphanExits: [], orphanEntries: [] }
  const sink: PassSink = {
    onEntry: (pass) => {
      log.entries.push(pass)
    },
    onPaired: (pair, exitVisit) => {
      log.paired.push({ pair, visit: exitVisit })
    },
    onOrphanExit: (v) => {
      log.orphanExits.push(v)
    },
    onOrphanEntry: (pass, reason) => {
      log.orphanEntries.push({ pass, reason })
    },
  }
  return { sink, log }
}

function makeQueue(sink: PassSink, overrides = {}) {
  let counter = 0
  return new SpindleQueue({
    entryCameraId: 'CAM-01',
    exitCameraId: 'CAM-02',
    orphanTimeoutMs: 300_000,
    maxDepth: 50,
    sink,
    newId: () => `pass-${++counter}`,
    ...overrides,
  })
}

describe('cross-camera pass identity', () => {
  // The defining requirement: both cameras' observations of one physical
  // spindle must carry the same spindle_pass_id.
  it('gives both cameras the same spindle_pass_id for one spindle', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-01', 6, 1000), 1000)
    queue.handleVisit(visit('CAM-02', 6, 5000), 5000)
    await queue.drain()

    assert.equal(log.entries.length, 1)
    assert.equal(log.paired.length, 1)
    assert.equal(
      log.paired[0].pair.spindlePassId,
      log.entries[0].spindlePassId,
      'the exit observation must reuse the entry observation id'
    )
    assert.equal(log.paired[0].pair.status, 'matched')
    assert.equal(log.paired[0].pair.mismatchDelta, 0)
  })

  it('pairs three spindles in order, never crossing their ids', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-01', 4, 1000), 1000) // A
    queue.handleVisit(visit('CAM-01', 5, 3000), 3000) // B
    queue.handleVisit(visit('CAM-01', 6, 5000), 5000) // C

    queue.handleVisit(visit('CAM-02', 4, 7000), 7000) // A'
    queue.handleVisit(visit('CAM-02', 5, 9000), 9000) // B'
    queue.handleVisit(visit('CAM-02', 6, 11000), 11000) // C'
    await queue.drain()

    assert.equal(log.paired.length, 3)
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        log.paired[i].pair.spindlePassId,
        log.entries[i].spindlePassId,
        `spindle ${i} paired against the wrong entry`
      )
      assert.equal(log.paired[i].pair.status, 'matched')
    }
  })

  it('pairs correctly when entries and exits interleave', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-01', 4, 1000), 1000) // A enters
    queue.handleVisit(visit('CAM-02', 4, 3000), 3000) // A' exits
    queue.handleVisit(visit('CAM-01', 7, 4000), 4000) // B enters
    queue.handleVisit(visit('CAM-02', 7, 6000), 6000) // B' exits
    await queue.drain()

    assert.equal(log.paired.length, 2)
    assert.equal(log.paired[0].pair.spindlePassId, log.entries[0].spindlePassId)
    assert.equal(log.paired[1].pair.spindlePassId, log.entries[1].spindlePassId)
  })
})

describe('mismatch reporting', () => {
  it('reports a signed delta so gains and losses are distinguishable', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-01', 8, 1000), 1000)
    queue.handleVisit(visit('CAM-02', 6, 3000), 3000)
    queue.handleVisit(visit('CAM-01', 5, 5000), 5000)
    queue.handleVisit(visit('CAM-02', 7, 7000), 7000)
    await queue.drain()

    assert.equal(log.paired[0].pair.mismatchDelta, -2, 'two toys lost in transit')
    assert.equal(log.paired[0].pair.status, 'mismatched')
    assert.equal(log.paired[1].pair.mismatchDelta, 2, 'two toys gained')
    assert.equal(log.paired[1].pair.status, 'mismatched')
  })
})

describe('unpairable observations', () => {
  it('records an exit with an empty queue as an orphan', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-02', 5, 1000), 1000)
    await queue.drain()

    assert.equal(log.orphanExits.length, 1)
    assert.equal(log.paired.length, 0)
  })

  it('times out a stale entry without shifting later pairings', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink, { orphanTimeoutMs: 10_000 })

    queue.handleVisit(visit('CAM-01', 4, 1000), 1000) // A — will never exit
    queue.handleVisit(visit('CAM-01', 9, 50_000), 50_000) // B, well past A's timeout
    queue.handleVisit(visit('CAM-02', 9, 52_000), 52_000) // B'
    await queue.drain()

    assert.equal(log.orphanEntries.length, 1)
    assert.equal(log.orphanEntries[0].reason, 'timeout')
    assert.equal(log.orphanEntries[0].pass.spindlePassId, log.entries[0].spindlePassId)

    // The critical part: B' paired with B, not with the abandoned A.
    assert.equal(log.paired.length, 1)
    assert.equal(log.paired[0].pair.spindlePassId, log.entries[1].spindlePassId)
    assert.equal(log.paired[0].pair.status, 'matched')
  })

  it('drops the oldest entry rather than growing without bound', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink, { maxDepth: 3 })

    for (let i = 0; i < 5; i += 1) {
      queue.handleVisit(visit('CAM-01', i, 1000 + i), 1000 + i)
    }
    await queue.drain()

    assert.equal(queue.depth, 3)
    assert.equal(log.orphanEntries.length, 2)
    assert.equal(log.orphanEntries[0].reason, 'overflow')
  })

  it('ignores visits from a camera that is neither entry nor exit', async () => {
    const { sink, log } = recorder()
    const queue = makeQueue(sink)

    queue.handleVisit(visit('CAM-99', 5, 1000), 1000)
    await queue.drain()

    assert.equal(queue.depth, 0)
    assert.equal(log.entries.length, 0)
    assert.equal(log.paired.length, 0)
  })
})
