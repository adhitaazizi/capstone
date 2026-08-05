import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REGISTRATION_STALE_MS, SessionRegistry } from '../../lib/inference/registry'

/** Register a source and the processed track derived from it, both stamped now. */
function pairedRegistry(sourceSessionId = 'src-1'): SessionRegistry {
  const registry = new SessionRegistry()
  registry.register('source', {
    'CAM-01': { sessionId: sourceSessionId, trackName: 'cam-01' },
  })
  registry.register('processed', {
    'CAM-01': {
      sessionId: 'proc-1',
      trackName: 'rfdetr-m-cam-01-abc',
      sourceSessionId,
    },
  })
  return registry
}

describe('SessionRegistry.liveProcessed', () => {
  it('serves a processed session backed by the current publisher', () => {
    const live = pairedRegistry().liveProcessed(Date.now())

    assert.deepEqual(Object.keys(live), ['CAM-01'])
    assert.equal(live['CAM-01'].sessionId, 'proc-1')
  })

  it('drops a processed session whose publisher was replaced', () => {
    const registry = pairedRegistry()

    // What a page reload / device switch / takeover looks like: same camera,
    // brand-new Cloudflare session. The worker is still bound to src-1 and
    // keeps heartbeating proc-1 as healthy, but proc-1 now carries nothing.
    registry.register('source', {
      'CAM-01': { sessionId: 'src-2', trackName: 'cam-01' },
    })

    assert.deepEqual(registry.liveProcessed(Date.now()), {})
  })

  it('drops a processed session once its own heartbeat goes stale', () => {
    const registry = pairedRegistry()

    assert.deepEqual(registry.liveProcessed(Date.now() + REGISTRATION_STALE_MS + 1), {})
  })

  it('drops a processed session when the publisher stops heartbeating', (t) => {
    // Session ids still match and the worker is still heartbeating, so only
    // the *source* freshness check can catch this one — it needs the two
    // registrations to carry genuinely different timestamps.
    t.mock.timers.enable({ apis: ['Date'], now: 0 })

    const registry = new SessionRegistry()
    registry.register('source', {
      'CAM-01': { sessionId: 'src-1', trackName: 'cam-01' },
    })

    // The browser tab goes away; the worker keeps heartbeating regardless.
    t.mock.timers.tick(REGISTRATION_STALE_MS + 1_000)
    registry.register('processed', {
      'CAM-01': {
        sessionId: 'proc-1',
        trackName: 'rfdetr-m-cam-01-abc',
        sourceSessionId: 'src-1',
      },
    })

    const now = Date.now()
    assert.ok(registry.isFresh('processed', 'CAM-01', now), 'worker still heartbeating')
    assert.ok(!registry.isFresh('source', 'CAM-01', now), 'publisher went quiet')
    assert.deepEqual(registry.liveProcessed(now), {})
  })

  it('drops a processed session with no matching source at all', () => {
    const registry = new SessionRegistry()
    registry.register('processed', {
      'CAM-01': {
        sessionId: 'proc-1',
        trackName: 'rfdetr-m-cam-01-abc',
        sourceSessionId: 'src-1',
      },
    })

    assert.deepEqual(registry.liveProcessed(Date.now()), {})
  })

  it('falls back to freshness alone when provenance is absent', () => {
    // capstone_inference.ipynb predates sourceSessionId. It has to keep
    // working, so an entry of unknown provenance is freshness-checked only —
    // never treated as matching, and never dropped for failing to match.
    const registry = new SessionRegistry()
    registry.register('source', {
      'CAM-01': { sessionId: 'src-1', trackName: 'cam-01' },
    })
    registry.register('processed', {
      'CAM-01': { sessionId: 'proc-1', trackName: 'rfdetr-m-cam-01-abc' },
    })
    const now = Date.now()

    assert.deepEqual(Object.keys(registry.liveProcessed(now)), ['CAM-01'])

    registry.register('source', {
      'CAM-01': { sessionId: 'src-2', trackName: 'cam-01' },
    })
    assert.deepEqual(Object.keys(registry.liveProcessed(now)), ['CAM-01'])

    assert.deepEqual(registry.liveProcessed(now + REGISTRATION_STALE_MS + 1), {})
  })

  it('keeps cameras independent', () => {
    const registry = new SessionRegistry()
    registry.register('source', {
      'CAM-01': { sessionId: 'src-1', trackName: 'cam-01' },
      'CAM-02': { sessionId: 'src-2', trackName: 'cam-02' },
    })
    registry.register('processed', {
      'CAM-01': { sessionId: 'p1', trackName: 't1', sourceSessionId: 'src-1' },
      'CAM-02': { sessionId: 'p2', trackName: 't2', sourceSessionId: 'src-2' },
    })

    // Only the entry camera's operator reloads.
    registry.register('source', {
      'CAM-01': { sessionId: 'src-1-new', trackName: 'cam-01' },
    })

    assert.deepEqual(Object.keys(registry.liveProcessed(Date.now())), ['CAM-02'])
  })
})
