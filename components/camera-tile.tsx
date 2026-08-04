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
}

const ICE_GATHERING_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

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
 */
export default function CameraTile({ camera, cfSessionId, cfTrackName }: CameraTileProps) {
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
    let attempt = 0

    const teardown = () => {
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
        setStatus('online')
        attempt = 0
      }

      conn.onconnectionstatechange = () => {
        if (disposed || pc !== conn) return
        const s = conn.connectionState
        if (s === 'connected') {
          attempt = 0
        } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          setStatus('offline')
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
        scheduleReconnect()
      })
    }
    run()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      // Closing the PeerConnection is what releases the viewer session:
      // Cloudflare's SFU reaps a session once its peer connection goes away.
      teardown()
      if (video) video.srcObject = null
    }
  }, [cfSessionId, cfTrackName, camera.id])

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
          <Badge variant={displayStatus === 'online' ? 'success' : 'danger'}>
            {displayStatus === 'online' ? 'ONLINE' : 'OFFLINE'}
          </Badge>
        </div>
      </div>

      {/* Offline / connecting overlay */}
      {displayStatus !== 'online' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">
              {displayStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              {displayStatus === 'connecting'
                ? 'Establishing Cloudflare stream…'
                : 'Waiting for the annotated stream from Colab.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
