'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, Power, RefreshCw, VideoOff } from 'lucide-react'

import Button from '@/components/ui/button'
import CameraTile from '@/components/camera-tile'
import { useSession } from '@/hooks/use-session'
import { usePublisher, publisherActions } from '@/hooks/use-publisher'
import type { CameraPublishState } from '@/lib/webrtc/publisher'

const LIVE_POLL_MS = 3000

interface ProcessedSession {
  sessionId: string
  trackName: string
}

/** Polls the same endpoint local-camera-grid.tsx uses for counts, but only
 *  reads processedSessions — the annotated track each camera published back
 *  by the GPU inference worker, once it has one. */
function useProcessedSessions(): Record<string, ProcessedSession> {
  const [sessions, setSessions] = useState<Record<string, ProcessedSession>>({})

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      try {
        const resp = await fetch('/api/inference/live')
        if (!resp.ok) return
        const body = await resp.json()
        if (!disposed && body.processedSessions) setSessions(body.processedSessions)
      } catch {
        // Transient — the next poll retries.
      }
    }
    void poll()
    const timer = setInterval(poll, LIVE_POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  return sessions
}

/** The raw local feed — imperative because React has no `srcObject` prop.
 *  This IS the same MediaStream the publisher captured for Cloudflare, not a
 *  second getUserMedia call, so there is only ever one open camera handle. */
function RawPreview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    if (stream) void video.play().catch(() => {})
    return () => {
      video.srcObject = null
    }
  }, [stream])

  return (
    <video
      ref={videoRef}
      className="h-full w-full object-cover"
      autoPlay
      muted
      playsInline
    />
  )
}

function CameraBox({
  camera,
  devices,
  isAdmin,
  processed,
  onSelect,
  onToggle,
}: {
  camera: CameraPublishState
  devices: { deviceId: string; label: string }[]
  isAdmin: boolean
  processed?: ProcessedSession
  onSelect: (deviceId: string) => void
  onToggle: () => void
}) {
  const enabled = camera.phase === 'live' || camera.phase === 'starting'
  const statusLabel =
    camera.phase === 'live'
      ? 'PUBLISHING'
      : camera.phase === 'starting'
        ? 'CONNECTING'
        : camera.phase === 'error'
          ? 'ERROR'
          : 'OFF'

  return (
    <section className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[#E2E8F0] px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-[#1E293B]">{camera.name} Camera</h2>
          <p className="text-sm text-[#64748B]">{camera.location}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            enabled ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#F1F5F9] text-[#64748B]'
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {/* Raw local preview underneath; the annotated track (once the GPU
          worker has published one back) is layered directly on top of it —
          this is what actually confirms the pipeline is working end to end,
          not just that a webcam is on. */}
      <div className="relative aspect-video bg-[#1E293B]">
        {camera.stream ? (
          <RawPreview stream={camera.stream} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60">
            <VideoOff className="mb-2 h-8 w-8" />
            <p className="text-sm">Camera is OFF</p>
          </div>
        )}
        {processed && (
          <div className="absolute inset-0">
            <CameraTile
              camera={{ id: camera.cameraId, name: camera.name, location: camera.location }}
              cfSessionId={processed.sessionId}
              cfTrackName={processed.trackName}
            />
          </div>
        )}
      </div>

      <div className="space-y-3 p-5">
        <label className="block text-sm font-medium text-[#334155]">
          Select camera
          <select
            className="mt-2 w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#0EA5E9] disabled:bg-[#F8FAFC]"
            value={camera.deviceId ?? ''}
            disabled={!isAdmin || devices.length === 0}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="" disabled>
              {devices.length === 0 ? 'No camera detected' : 'No camera selected'}
            </option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        {camera.error && (
          <p className="text-xs font-medium text-[#B91C1C]">{camera.error}</p>
        )}

        {isAdmin && (
          <Button
            className="w-full"
            size="sm"
            variant={enabled ? 'danger' : 'success'}
            disabled={!camera.deviceId}
            onClick={onToggle}
          >
            <Power className="mr-2 h-4 w-4" />
            {enabled ? 'Turn camera OFF' : 'Turn camera ON'}
          </Button>
        )}
      </div>
    </section>
  )
}

export default function LiveCameraSelection() {
  const { isLoading: authLoading, isAdmin } = useSession()
  const snapshot = usePublisher()
  const actions = publisherActions()
  const processedSessions = useProcessedSessions()

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  if (!snapshot.supported) {
    return (
      <div className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
        This browser can&apos;t publish cameras — it needs a secure context
        (HTTPS or localhost), getUserMedia, and WebRTC support.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
          <p className="mt-1 text-[#64748B]">
            Select one camera for each checkpoint, then turn it on to publish.
          </p>
        </div>
        {isAdmin && snapshot.permission !== 'granted' && (
          <Button variant="secondary" onClick={() => void actions.requestPermission()}>
            <Camera className="mr-2 h-4 w-4" />
            Grant camera access
          </Button>
        )}
        {isAdmin && snapshot.permission === 'granted' && (
          <Button variant="secondary" onClick={() => void actions.refreshDevices()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Detect cameras
          </Button>
        )}
      </div>

      {snapshot.registerError && (
        <div className="mb-5 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          {snapshot.registerError}
        </div>
      )}
      {snapshot.takeoverWarning && (
        <div className="mb-5 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] p-4 text-sm text-[#1D4ED8]">
          {snapshot.takeoverWarning}
        </div>
      )}
      {actions.duplicateSelection() && (
        <div className="mb-5 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-4 text-sm text-[#92400E]">
          Entry and exit are assigned the same camera — pick two different
          devices, or a spindle can never be paired.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {snapshot.cameras.map((camera) => (
          <CameraBox
            key={camera.cameraId}
            camera={camera}
            devices={snapshot.devices}
            isAdmin={isAdmin}
            processed={processedSessions[camera.cameraId]}
            onSelect={(deviceId) => actions.selectDevice(camera.cameraId, deviceId)}
            onToggle={() =>
              void (camera.phase === 'live' || camera.phase === 'starting'
                ? actions.stopOne(camera.cameraId)
                : actions.startOne(camera.cameraId))
            }
          />
        ))}
      </div>
    </div>
  )
}
