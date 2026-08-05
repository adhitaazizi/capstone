/**
 * VP8 enforcement for published video.
 *
 * This is not a preference, it is a hard requirement of the pipeline. The GPU
 * inference worker forces VP8 codec preferences on its receiving transceiver
 * (services/inference/webrtc.py's force_vp8) and then waits up to 60 s for a
 * decodable frame (services/inference/pipeline.py). If the browser negotiates
 * H.264 instead, no frame ever decodes and the worker dies at startup with an
 * error that says nothing about codecs.
 *
 * So we do it twice: set the codec preferences, then assert on the generated
 * SDP that H.264 really is gone. The assertion is what turns a silent
 * downstream failure into an immediate, local, readable one.
 */

/**
 * Restrict a transceiver to VP8 (plus retransmission).
 *
 * Throws rather than degrading: publishing H.264 looks fine here and breaks the
 * GPU worker, so failing loudly at the publisher is strictly better.
 */
export function preferVp8(transceiver: RTCRtpTransceiver): void {
  if (typeof transceiver.setCodecPreferences !== 'function') {
    throw new Error(
      'This browser cannot pin the video codec (setCodecPreferences is ' +
        'unavailable). Use Chrome or Edge.'
    )
  }

  // Sender, not receiver: this transceiver is sendonly, and the two capability
  // lists are not guaranteed to match.
  const capabilities = RTCRtpSender.getCapabilities('video')
  if (!capabilities) {
    throw new Error('This browser does not report video codec capabilities.')
  }

  const codecs = capabilities.codecs.filter((codec) => {
    const mime = codec.mimeType.toLowerCase()
    // rtx is retransmission, not a video codec. aiortc drops it because aiortc
    // has no rtx support; a browser keeping it just means packet loss degrades
    // the stream instead of freezing it.
    return mime === 'video/vp8' || mime === 'video/rtx'
  })

  if (!codecs.some((codec) => codec.mimeType.toLowerCase() === 'video/vp8')) {
    throw new Error('This browser cannot send VP8. Use Chrome or Edge.')
  }

  transceiver.setCodecPreferences(codecs)
}

/**
 * Assert that an offer advertises VP8 and does not advertise H.264.
 *
 * Run on the offer *before* setLocalDescription, so a bad offer is never sent
 * to Cloudflare in the first place.
 */
export function assertVp8Only(sdp: string): void {
  const videoSection = sdp
    .split(/^m=/m)
    .find((section) => section.startsWith('video'))

  if (!videoSection) {
    throw new Error('Offer contains no video m-line.')
  }
  if (!/a=rtpmap:\d+ VP8\/90000/i.test(videoSection)) {
    throw new Error(
      'Offer does not advertise VP8; the GPU inference worker only decodes VP8.'
    )
  }
  if (/a=rtpmap:\d+ H264\/90000/i.test(videoSection)) {
    throw new Error(
      'Offer still advertises H.264 after setCodecPreferences; refusing to ' +
        'publish because the GPU inference worker would silently never receive ' +
        'a decodable frame.'
    )
  }
}
