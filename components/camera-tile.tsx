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
  detectionCount?: number
}

export default function CameraTile({
  camera,
  cfSessionId,
  cfTrackName,
  detectionCount,
}: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')

  useEffect(() => {
    if (!cfSessionId || !cfTrackName) {
      setStatus('offline')
      return
    }

    let pc: RTCPeerConnection | null = null
    let disposed = false

    const connect = async () => {
      setStatus('connecting')
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
      })

      pc.ontrack = (e) => {
        if (disposed) return
        const v = videoRef.current
        if (v) {
          v.srcObject = new MediaStream([e.track])
          v.play().catch(() => {})
          setStatus('online')
        }
      }

      pc.onconnectionstatechange = () => {
        if (disposed) return
        const s = pc?.connectionState
        if (s === 'failed' || s === 'disconnected') setStatus('offline')
      }

      pc.addTransceiver('video', { direction: 'recvonly' })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Wait for ICE gathering to complete
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const done = () => { if (pc?.iceGatheringState === 'complete') resolve() }
          pc!.addEventListener('icegatheringstatechange', done)
          setTimeout(resolve, 10_000)
        })
      }

      // Create a new viewer session via server-side signaling proxy
      const sessionResp = await fetch('/api/cloudflare/signal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: '/sessions/new',
          body: {
            sessionDescription: {
              type: pc.localDescription!.type,
              sdp: pc.localDescription!.sdp,
            },
          },
        }),
      })
      const sessionData = await sessionResp.json()
      const viewerSessionId: string = sessionData.sessionId
      await pc.setRemoteDescription(new RTCSessionDescription(sessionData.sessionDescription))

      // Pull the processed track from the Colab publisher session
      const tracksResp = await fetch('/api/cloudflare/signal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: `/sessions/${viewerSessionId}/tracks/new`,
          body: {
            tracks: [{ location: 'remote', sessionId: cfSessionId, trackName: cfTrackName }],
          },
        }),
      })
      const tracksData = await tracksResp.json()

      if (tracksData.requiresImmediateRenegotiation) {
        await pc.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        if (pc.iceGatheringState !== 'complete') {
          await new Promise<void>((resolve) => {
            const done = () => { if (pc?.iceGatheringState === 'complete') resolve() }
            pc!.addEventListener('icegatheringstatechange', done)
            setTimeout(resolve, 10_000)
          })
        }

        await fetch('/api/cloudflare/signal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: `/sessions/${viewerSessionId}/renegotiate`,
            method: 'PUT',
            body: {
              sessionDescription: {
                type: pc.localDescription!.type,
                sdp: pc.localDescription!.sdp,
              },
            },
          }),
        })
      } else if (tracksData.sessionDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
      }
    }

    connect().catch((err) => {
      if (!disposed) {
        console.error(`[${camera.id}] Cloudflare WebRTC failed:`, err)
        setStatus('offline')
      }
    })

    return () => {
      disposed = true
      pc?.close()
      const v = videoRef.current
      if (v) v.srcObject = null
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
          <div className="flex items-center gap-2">
            {detectionCount !== undefined && detectionCount > 0 && (
              <span className="rounded bg-green-500/80 px-2 py-0.5 text-xs font-semibold text-white">
                {detectionCount} detected
              </span>
            )}
            <Badge variant={status === 'online' ? 'success' : 'danger'}>
              {status === 'online' ? 'ONLINE' : 'OFFLINE'}
            </Badge>
          </div>
        </div>
      </div>

      {/* Status bar */}
      {status === 'online' && (
        <div className="absolute bottom-0 left-0 w-full bg-black/50 px-3 py-1 text-xs text-white">
          {detectionCount !== undefined && detectionCount > 0 ? (
            <span className="text-green-400">✓ {detectionCount} detected</span>
          ) : (
            <span className="text-gray-300">● Processing…</span>
          )}
        </div>
      )}

      {/* Offline / connecting overlay */}
      {status !== 'online' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">
              {status === 'connecting' ? 'Connecting…' : 'Offline'}
            </p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              {status === 'connecting'
                ? 'Establishing Cloudflare stream…'
                : 'Waiting for processed stream from Colab.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
