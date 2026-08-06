import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CONSUMER_STALE_MS, ConsumerRegistry } from '../../lib/inference/consumers'

describe('ConsumerRegistry', () => {
  it('reports a camera as consumed right after a heartbeat', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)

    assert.equal(consumers.get('CAM-01', now)?.sessionId, 'proc-1')
    assert.deepEqual(consumers.active(now), ['CAM-01'])
  })

  it('reports nothing for a camera that never heartbeated', () => {
    const consumers = new ConsumerRegistry()

    assert.equal(consumers.get('CAM-01', Date.now()), null)
    assert.deepEqual(consumers.active(Date.now()), [])
  })

  it('expires an entry once the viewer stops heartbeating', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)

    // One tick before the window closes the viewer still counts — the
    // heartbeat interval must be allowed to jitter without pausing counting.
    assert.notEqual(consumers.get('CAM-01', now + CONSUMER_STALE_MS - 1), null)
    assert.equal(consumers.get('CAM-01', now + CONSUMER_STALE_MS), null)
  })

  it('records the session being decoded, not merely that a viewer exists', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)
    consumers.heartbeat('CAM-01', 'proc-2', now)

    // This is what lets pipeline.isCounting() reject a tile still nursing the
    // annotated track of a worker that has since restarted and republished.
    assert.equal(consumers.get('CAM-01', now)?.sessionId, 'proc-2')
  })

  it('releases one camera without disturbing the other', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)
    consumers.heartbeat('CAM-02', 'proc-2', now)

    consumers.release(['CAM-01'])

    assert.equal(consumers.get('CAM-01', now), null)
    assert.equal(consumers.get('CAM-02', now)?.sessionId, 'proc-2')
  })

  it('releases everything when given no camera ids', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)
    consumers.heartbeat('CAM-02', 'proc-2', now)

    // The keepalive DELETE fired on teardown sends no body.
    consumers.release()

    assert.deepEqual(consumers.active(now), [])
  })

  it('resumes immediately after a lapse rather than staying latched off', () => {
    const now = Date.now()
    const consumers = new ConsumerRegistry()
    consumers.heartbeat('CAM-01', 'proc-1', now)

    const afterLapse = now + CONSUMER_STALE_MS * 3
    assert.equal(consumers.get('CAM-01', afterLapse), null)

    consumers.heartbeat('CAM-01', 'proc-1', afterLapse)
    assert.deepEqual(consumers.active(afterLapse), ['CAM-01'])
  })
})
