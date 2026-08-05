import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseSourceRegistration } from '../../lib/inference/source-registration'

const GOOD = {
  sessions: {
    'CAM-01': { sessionId: 'a1b2c3d4e5', trackName: 'cam-01' },
    'CAM-02': { sessionId: 'f6g7h8i9j0', trackName: 'cam-02' },
  },
}

describe('parseSourceRegistration', () => {
  it('accepts a well-formed two-camera registration', () => {
    const result = parseSourceRegistration(GOOD)
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.sessions, GOOD.sessions)
  })

  it('accepts a single camera', () => {
    const result = parseSourceRegistration({
      sessions: { 'CAM-01': { sessionId: 'abc123', trackName: 'cam-01' } },
    })
    assert.equal(result.ok, true)
  })

  it('rejects an unknown camera id', () => {
    // The failure this guard exists for: an unknown id reaches the GPU worker,
    // which subscribes to a Cloudflare track that does not exist and dies at
    // startup rather than skipping it.
    const result = parseSourceRegistration({
      sessions: { 'CAM-99': { sessionId: 'abc123', trackName: 'cam-99' } },
    })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /Unknown camera id: CAM-99/)
  })

  it('rejects a trackName that does not match the camera id', () => {
    // Accepting a client-supplied trackName would let one publisher claim both
    // cameras' track names, violating the uniqueness normalize_cameras expects.
    const result = parseSourceRegistration({
      sessions: { 'CAM-01': { sessionId: 'abc123', trackName: 'cam-02' } },
    })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /trackName must be "cam-01"/)
  })

  it('rejects a sessionId with path-traversal characters', () => {
    const result = parseSourceRegistration({
      sessions: {
        'CAM-01': { sessionId: '../../etc/passwd', trackName: 'cam-01' },
      },
    })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /alphanumeric/)
  })

  it('rejects an empty or missing sessionId', () => {
    for (const sessionId of ['', '   ', undefined]) {
      const result = parseSourceRegistration({
        sessions: { 'CAM-01': { sessionId, trackName: 'cam-01' } },
      })
      assert.equal(
        result.ok,
        false,
        `expected rejection for ${String(sessionId)}`
      )
    }
  })

  it('rejects a sessionId longer than 64 characters', () => {
    const result = parseSourceRegistration({
      sessions: { 'CAM-01': { sessionId: 'a'.repeat(65), trackName: 'cam-01' } },
    })
    assert.equal(result.ok, false)
  })

  it('rejects an empty sessions map', () => {
    const result = parseSourceRegistration({ sessions: {} })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /empty/)
  })

  it('rejects non-object bodies and non-object sessions', () => {
    for (const body of [
      null,
      [],
      'string',
      42,
      { sessions: null },
      { sessions: [] },
    ]) {
      const result = parseSourceRegistration(body)
      assert.equal(
        result.ok,
        false,
        `expected rejection for ${JSON.stringify(body)}`
      )
    }
  })

  it('rejects a non-object camera entry', () => {
    const result = parseSourceRegistration({ sessions: { 'CAM-01': 'nope' } })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /must be an object/)
  })
})
