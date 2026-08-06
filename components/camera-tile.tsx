'use client'

import React, { useEffect, useRef, useState } from 'react'
import Badge from '@/components/ui/badge'

interface Camera {
  id: string
  name: string
  location: string
}

interface CameraTileProps {
  camera: Camera
  cfSessionId?: string
  cfTrackName?: string
  /**
   * Heartbeat `POST /api/cameras/consume` while frames are decoding, which is
   * what opens the server-side counting gate (lib/inference/consumers.ts).
   *
   * Opt-in rather than always-on so that "counting is running" stays tied to
   * one specific surface — /cameras — instead of to whichever page happens to
   * be open. A tile rendered anywhere else is a passive viewer.
   */
  reportConsumption?: boolean
}

const ICE_GATHERING_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const FRAME_POLL_MS = 2_000
/** ~6 s of a connected track decoding nothing before we call it dead. */
const STALLED_POLLS_BEFORE_RECONNECT = 3

/**
 * Resolve once ICE gathering completes, or after a timeout.
 *
 * The listener and the timer are both cleaned up on either path. The previous
 * inline version left the `icegatheringstatechange` listener attached and never
 * cleared its timeout, so every reconnect leaked both.
 */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false

    // Declared as hoisted functions so `finish` can close over `timer`, which
    // is assigned synchronously below and therefore always set by the time
    // either the timeout or the listener can fire.
    function finish() {
      if (settled) return
      settled = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }

    function onChange() {
      if (pc.iceGatheringState === 'complete') finish()
    }

    pc.addEventListener('icegatheringstatechange', onChange)
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS)
  })
}

async function signal(path: string, body: unknown, method?: string) {
  const resp = await fetch('/api/cloudflare/signal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, body, method }),
  })
  if (!resp.ok) {
    throw new Error(`Signaling failed (${resp.status}) for ${path}`)
  }
  return resp.json()
}

/**
 * Displays the annotated stream that Colab publishes back to Cloudflare
 * Realtime. Deliberately shows no counts — counts come from the server-side
 * sampling pipeline and are rendered once, in the grid header, rather than
 * per tile where two cameras' numbers invite being read as a total.
 *
 * With `reportConsumption`, this tile is also the thing that *permits* counting:
 * its framesDecoded watchdog heartbeats /api/cameras/consume, and the pipeline
 * drops detections for any camera without a fresh heartbeat. So the same signal
 * that decides whether to show a picture decides whether to count — the tile
 * can never display a spinner while rows are quietly being written behind it.
 */
export default function CameraTile({
  camera,
  cfSessionId,
  cfTrackName,
  reportConsumption = false,
}: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')

  // Derived rather than pushed through setState from the effect body: with no
  // session there is nothing to connect to, and this keeps the effect free of
  // synchronous state updates.
  const hasTarget = Boolean(cfSessionId && cfTrackName)
  const displayStatus = hasTarget ? status : 'offline'

  useEffect(() => {
    if (!cfSessionId || !cfTrackName) return

    const video = videoRef.current
    let disposed = false
    let pc: RTCPeerConnection | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let frameTimer: ReturnType<typeof setInterval> | null = null
    let attempt = 0
    let consuming = false

    /**
     * Tell the server this tile is decoding annotated frames right now.
     *
     * Sent from the frame watchdog rather than on a timer of its own, and only
     * when framesDecoded has advanced, so it stops by itself the moment the
     * picture freezes — which is exactly when counting should pause. Failures
     * are swallowed: the server's staleness window closes the gate anyway, and
     * a toast about a heartbeat would be noise the operator cannot act on.
     */
    const heartbeatConsumption = () => {
      if (!reportConsumption || disposed) return
      consuming = true
      void fetch('/api/cameras/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cameraId: camera.id, sessionId: cfSessionId }),
      }).catch(() => {})
    }

    // keepalive so the release still lands when this fires during a page
    // navigation away from /cameras, which would otherwise abort it.
    const releaseConsumption = () => {
      if (!consuming) return
      consuming = false
      void fetch('/api/cameras/consume', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cameraIds: [camera.id] }),
        keepalive: true,
      }).catch(() => {})
    }

    const stopFrameWatchdog = () => {
      if (!frameTimer) return
      clearInterval(frameTimer)
      frameTimer = null
    }

    /**
     * Gate 'online' on frames actually decoding, not on a track arriving.
     *
     * `ontrack` fires as soon as the transceiver is negotiated, and Cloudflare's
     * SFU hands over a track even when nothing is publishing into it — so the
     * old version reported ONLINE for a stream that would never render, and the
     * tile's opaque background then hid the operator's own camera preview
     * behind a black rectangle. Watching framesDecoded also catches the case
     * where the session is correct but the codec never produces a frame.
     */
    const startFrameWatchdog = (conn: RTCPeerConnection) => {
      stopFrameWatchdog()
      let lastDecoded = -1
      let stalledPolls = 0

      frameTimer = setInterval(async () => {
        if (disposed || pc !== conn) return

        let decoded = 0
        try {
          const stats = await conn.getStats()
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
              const framesDecoded = (report as { framesDecoded?: number }).framesDecoded
              if (typeof framesDecoded === 'number') {
                decoded = Math.max(decoded, framesDecoded)
              }
            }
          })
        } catch {
          return // Transient — the next poll retries.
        }
        if (disposed || pc !== conn) return

        if (decoded > lastDecoded) {
          lastDecoded = decoded
          stalledPolls = 0
          // The first poll sees 0 and must not count as progress.
          if (decoded > 0) {
            setStatus('online')
            attempt = 0
            heartbeatConsumption()
          }
          return
        }

        stalledPolls += 1
        if (stalledPolls >= STALLED_POLLS_BEFORE_RECONNECT) {
          setStatus('offline')
          // Released rather than left to age out, so counting pauses now
          // instead of CONSUMER_STALE_MS after the picture froze.
          releaseConsumption()
          stopFrameWatchdog()
          teardown()
          scheduleReconnect()
        }
      }, FRAME_POLL_MS)
    }

    const teardown = () => {
      stopFrameWatchdog()
      if (!pc) return
      pc.ontrack = null
      pc.onconnectionstatechange = null
      for (const receiver of pc.getReceivers()) receiver.track?.stop()
      pc.close()
      pc = null
    }

    // Without this, a single transient network blip blanks the tile until the
    // operator reloads the page.
    const scheduleReconnect = () => {
      if (disposed || retryTimer) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
      attempt += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        setStatus('connecting')
        teardown()
        void connect()
      }, delay)
    }

    const connect = async () => {
      if (disposed) return

      const conn = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
      })
      pc = conn

      conn.ontrack = (e) => {
        if (disposed || pc !== conn || !video) return
        video.srcObject = new MediaStream([e.track])
        video.play().catch(() => {})
        // Status stays 'connecting' until startFrameWatchdog sees a frame
        // actually decode — a track object is not a picture.
        startFrameWatchdog(conn)
      }

      conn.onconnectionstatechange = () => {
        if (disposed || pc !== conn) return
        const s = conn.connectionState
        if (s === 'connected') {
          attempt = 0
        } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          setStatus('offline')
          releaseConsumption()
          scheduleReconnect()
        }
      }

      conn.addTransceiver('video', { direction: 'recvonly' })
      await conn.setLocalDescription(await conn.createOffer())
      await waitForIceGathering(conn)
      if (disposed || pc !== conn) return

      // Create a viewer session through the server-side signaling proxy, which
      // holds CF_APP_SECRET.
      const sessionData = await signal('/sessions/new', {
        sessionDescription: {
          type: conn.localDescription!.type,
          sdp: conn.localDescription!.sdp,
        },
      })
      if (disposed || pc !== conn) return

      const viewerSessionId: string = sessionData.sessionId
      await conn.setRemoteDescription(new RTCSessionDescription(sessionData.sessionDescription))

      // Pull the annotated track out of Colab's publisher session.
      const tracksData = await signal(`/sessions/${viewerSessionId}/tracks/new`, {
        tracks: [{ location: 'remote', sessionId: cfSessionId, trackName: cfTrackName }],
      })
      if (disposed || pc !== conn) return

      if (tracksData.requiresImmediateRenegotiation) {
        await conn.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
        await conn.setLocalDescription(await conn.createAnswer())
        await waitForIceGathering(conn)
        if (disposed || pc !== conn) return

        await signal(
          `/sessions/${viewerSessionId}/renegotiate`,
          {
            sessionDescription: {
              type: conn.localDescription!.type,
              sdp: conn.localDescription!.sdp,
            },
          },
          'PUT'
        )
      } else if (tracksData.sessionDescription) {
        await conn.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
      }
    }

    const run = () => {
      connect().catch((err) => {
        if (disposed) return
        console.error(`[${camera.id}] Cloudflare WebRTC failed:`, err)
        setStatus('offline')
        releaseConsumption()
        scheduleReconnect()
      })
    }
    run()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      // Before `disposed` can suppress anything else: navigating away from
      // /cameras must stop counting, not leave it running on a dead viewer.
      releaseConsumption()
      stopFrameWatchdog()
      // Closing the PeerConnection is what releases the viewer session:
      // Cloudflare's SFU reaps a session once its peer connection goes away.
      teardown()
      if (video) video.srcObject = null
    }
  }, [cfSessionId, cfTrackName, camera.id, reportConsumption])

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#1E293B]">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        autoPlay
        muted
        playsInline
      />

      {/* Header */}
      <div className="absolute left-0 top-0 w-full bg-linear-to-b from-black/60 to-transparent p-3">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white drop-shadow">{camera.name}</h3>
            <p className="text-xs text-white/80 drop-shadow">{camera.location}</p>
          </div>
          <Badge
            variant={
              displayStatus === 'online'
                ? 'success'
                : displayStatus === 'connecting'
                  ? 'warning'
                  : 'danger'
            }
          >
            {displayStatus === 'online'
              ? 'ONLINE'
              : displayStatus === 'connecting'
                ? 'WAITING'
                : 'OFFLINE'}
          </Badge>
        </div>
      </div>

      {/* Waiting overlay. Opaque, not translucent: there is no raw preview
          underneath any more, so there is nothing to see through to. */}
      {displayStatus !== 'online' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#1E293B] px-6 text-center">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-white/15 border-t-[#0EA5E9]" />
          <p className="mt-4 text-sm font-semibold text-white">
            Waiting for the annotated stream…
          </p>
          <p className="mt-1 text-xs text-[#94A3B8]">
            {displayStatus === 'connecting'
              ? 'Connecting to the annotated track.'
              : 'No annotated frames from the inference worker yet.'}
          </p>
        </div>
      )}
    </div>
  )
}
