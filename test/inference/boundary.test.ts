import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateFrame, isInsideSpindle } from '../../lib/inference/boundary'
import type { NormalizedBox, RawDetection, RawFrame } from '../../lib/inference/types'

/** Build a hot-wheels box centred at (u, v) in spindle-relative unit space. */
function toyAt(spindle: NormalizedBox, u: number, v: number, conf = 0.9): RawDetection {
  const [sx1, sy1, sx2, sy2] = spindle
  const cx = sx1 + u * (sx2 - sx1)
  const cy = sy1 + v * (sy2 - sy1)
  const half = 0.01
  return { cls: 'hot wheels', conf, box: [cx - half, cy - half, cx + half, cy + half] }
}

function spindleDet(box: NormalizedBox, conf = 0.9): RawDetection {
  return { cls: 'spindle', conf, box }
}

function frame(detections: RawDetection[], ts = 1_000): RawFrame {
  return { ts, detections }
}

describe('spindle-relative normalization', () => {
  // The property the whole normalization exists for: the spindle's box is not
  // the same on every sample, so containment must not depend on its size or
  // position — only on where a toy sits relative to it.
  it('gives identical decisions for a spindle box of a different size and position', () => {
    const small: NormalizedBox = [0.1, 0.1, 0.3, 0.3]
    const large: NormalizedBox = [0.2, 0.4, 0.8, 1.0]

    const relativePositions: [number, number][] = [
      [0.5, 0.5], // dead centre
      [0.0, 0.0], // exact corner
      [1.0, 1.0], // opposite corner
      [1.1, 0.5], // just outside, inside the margin
      [1.9, 0.5], // clearly outside
      [-0.5, 0.5],
    ]

    for (const [u, v] of relativePositions) {
      const inSmall = evaluateFrame(
        frame([spindleDet(small), toyAt(small, u, v)])
      ).count
      const inLarge = evaluateFrame(
        frame([spindleDet(large), toyAt(large, u, v)])
      ).count

      assert.equal(
        inSmall,
        inLarge,
        `relative position (${u}, ${v}) was counted differently across spindle sizes`
      )
    }
  })

  it('accepts a centroid just outside the box but within the margin', () => {
    const box: NormalizedBox = [0.2, 0.2, 0.8, 0.8]
    assert.equal(isInsideSpindle([0.2 + 1.1 * 0.6, 0.5], box, 0.15), true)
    assert.equal(isInsideSpindle([0.2 + 1.2 * 0.6, 0.5], box, 0.15), false)
  })

  it('rejects a degenerate spindle box rather than dividing by zero', () => {
    const degenerate: NormalizedBox = [0.5, 0.5, 0.5, 0.5]
    const result = evaluateFrame(
      frame([spindleDet(degenerate), { cls: 'hot wheels', conf: 0.9, box: [0.4, 0.4, 0.6, 0.6] }])
    )
    assert.equal(result.spindlePresent, false)
    assert.equal(result.count, 0)
  })
})

describe('evaluateFrame', () => {
  const box: NormalizedBox = [0.1, 0.1, 0.9, 0.9]

  it('counts only toys inside the boundary and reports the rest as rejected', () => {
    const result = evaluateFrame(
      frame([
        spindleDet(box),
        toyAt(box, 0.2, 0.2),
        toyAt(box, 0.5, 0.5),
        toyAt(box, 0.8, 0.8),
        toyAt(box, 2.5, 0.5), // a toy on the next spindle over
      ])
    )

    assert.equal(result.count, 3)
    assert.equal(result.rejected, 1)
    assert.equal(result.spindlePresent, true)
  })

  it('distinguishes "no spindle" from "spindle holding zero toys"', () => {
    const noSpindle = evaluateFrame(frame([toyAt(box, 0.5, 0.5)]))
    assert.equal(noSpindle.spindlePresent, false)
    assert.equal(noSpindle.count, 0)

    const emptySpindle = evaluateFrame(frame([spindleDet(box)]))
    assert.equal(emptySpindle.spindlePresent, true)
    assert.equal(emptySpindle.count, 0)
  })

  it('drops detections below the per-class confidence floors', () => {
    const result = evaluateFrame(
      frame([spindleDet(box), toyAt(box, 0.5, 0.5, 0.9), toyAt(box, 0.6, 0.6, 0.1)])
    )
    assert.equal(result.count, 1)
  })

  it('treats a low-confidence spindle as no spindle', () => {
    const result = evaluateFrame(frame([spindleDet(box, 0.2), toyAt(box, 0.5, 0.5)]))
    assert.equal(result.spindlePresent, false)
  })

  it('measures against the foreground spindle, not a high-confidence sliver', () => {
    // A background spindle clipping the frame edge can score a high confidence
    // on a tiny box. Ranking by confidence alone would measure this frame's
    // toys against the wrong spindle.
    const foreground: NormalizedBox = [0.3, 0.3, 0.9, 0.9]
    const sliver: NormalizedBox = [0.0, 0.0, 0.03, 0.9]

    const result = evaluateFrame(
      frame([
        spindleDet(sliver, 0.99),
        spindleDet(foreground, 0.8),
        toyAt(foreground, 0.5, 0.5),
        toyAt(foreground, 0.7, 0.7),
      ])
    )

    assert.deepEqual(result.spindleBox, foreground)
    assert.equal(result.count, 2)
  })

  it('accepts both hot-wheels class spellings from the checkpoint', () => {
    const result = evaluateFrame(
      frame([
        spindleDet(box),
        { ...toyAt(box, 0.4, 0.4), cls: 'hot-wheels-fd1tsjbuot2qusqjctck' },
        { ...toyAt(box, 0.6, 0.6), cls: 'Hot Wheels' },
      ])
    )
    assert.equal(result.count, 2)
  })
})
