import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { assertVp8Only } from '../../lib/webrtc/vp8'

/**
 * Minimal but structurally faithful SDP fixtures. Only the parts assertVp8Only
 * inspects are realistic; the rest is trimmed so a failure points at the codec
 * lines rather than at SDP noise.
 */
function offer(rtpmapLines: string[], { video = true } = {}): string {
  const session = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0']
  if (!video) return session.join('\r\n')
  return [
    ...session,
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=sendonly',
    ...rtpmapLines,
  ].join('\r\n')
}

const VP8 = 'a=rtpmap:96 VP8/90000'
const VP8_RTX = 'a=rtpmap:97 rtx/90000'
const H264 = 'a=rtpmap:102 H264/90000'

describe('assertVp8Only', () => {
  it('accepts a VP8-only offer', () => {
    assert.doesNotThrow(() => assertVp8Only(offer([VP8, VP8_RTX])))
  })

  it('rejects an offer that still advertises H.264', () => {
    // The failure this whole guard exists to prevent: setCodecPreferences did
    // not take, the GPU worker receives undecodable media and times out after
    // 60 s with an error that never mentions codecs.
    assert.throws(() => assertVp8Only(offer([VP8, H264])), /H\.264/)
  })

  it('rejects an offer with no VP8 at all', () => {
    assert.throws(() => assertVp8Only(offer([H264])), /does not advertise VP8/)
  })

  it('rejects an offer with no video m-line', () => {
    assert.throws(
      () => assertVp8Only(offer([], { video: false })),
      /no video m-line/
    )
  })

  it('ignores codec lines outside the video section', () => {
    // An audio m-line carrying an unrelated payload must not be mistaken for
    // the video section. Cloudflare sessions here are video-only, but the
    // parser should not depend on that.
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=sendonly',
      VP8,
    ].join('\r\n')
    assert.doesNotThrow(() => assertVp8Only(sdp))
  })

  it('tolerates LF-only line endings', () => {
    const sdp = offer([VP8]).replace(/\r\n/g, '\n')
    assert.doesNotThrow(() => assertVp8Only(sdp))
  })
})
