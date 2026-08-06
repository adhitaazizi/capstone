'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'

import Badge from '@/components/ui/badge'
import {
  inferenceViewer,
  type InferenceViewerSnapshot,
} from '@/lib/webrtc/inference-viewer'

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

const EMPTY_SNAPSHOT: InferenceViewerSnapshot = { status: 'offline', stream: null }

/**
 * The viewer connection belongs to a browser-global registry. Navigating away
 * from Live Cameras therefore only removes this video element; it does not
 * close the Cloudflare viewer session or force the AI track to reconnect.
 */
export default function CameraTile({ camera, cfSessionId, cfTrackName }: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const viewer = inferenceViewer(camera.id)
  const snapshot = useSyncExternalStore(
    viewer.subscribe,
    viewer.getSnapshot,
    () => EMPTY_SNAPSHOT
  )
  const hasTarget = Boolean(cfSessionId && cfTrackName)
  const status = hasTarget ? snapshot.status : 'offline'

  useEffect(() => {
    if (cfSessionId && cfTrackName) viewer.ensure(cfSessionId, cfTrackName)
  }, [cfSessionId, cfTrackName, viewer])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = snapshot.stream
    if (snapshot.stream) void video.play().catch(() => {})
    return () => {
      video.srcObject = null
    }
  }, [snapshot.stream])

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#1E293B]">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        autoPlay
        muted
        playsInline
      />

      <div className="absolute left-0 top-0 w-full bg-linear-to-b from-black/60 to-transparent p-3">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white drop-shadow">{camera.name}</h3>
            <p className="text-xs text-white/80 drop-shadow">{camera.location}</p>
          </div>
          <Badge variant={status === 'online' ? 'success' : 'danger'}>
            {status === 'online' ? 'ONLINE' : 'OFFLINE'}
          </Badge>
        </div>
      </div>

      {status !== 'online' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">
              {status === 'connecting' ? 'Connecting...' : 'Offline'}
            </p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              {status === 'connecting'
                ? 'Waiting for the first annotated frame...'
                : 'No annotated frames from the inference worker.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
