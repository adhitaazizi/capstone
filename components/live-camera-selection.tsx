'use client'

import { useEffect, useState } from 'react'
import { Camera, Power, RefreshCw, VideoOff } from 'lucide-react'

import Button from '@/components/ui/button'
import CameraTile from '@/components/camera-tile'
import { useSession } from '@/hooks/use-session'
import { usePublisher, publisherActions } from '@/hooks/use-publisher'
import type { CameraPublishState } from '@/lib/webrtc/publisher'

const LIVE_POLL_MS = 1000

interface ProcessedSession {
  sessionId: string
  trackName: string
}

interface CameraLive {
  spindlePresent: boolean
  intervalCount: number
  lastVisitCount: number | null
  lastSampleAt: number | null
  framesReceived: number
}

interface PairedPass {
  spindleNumber: number
  entryCount: number
  exitCount: number
  mismatchDelta: number
  status: 'matched' | 'mismatched'
  exitTime: number
}

interface LiveResponse {
  processedSessions: Record<string, ProcessedSession>
  cameras: Record<string, CameraLive>
  recentPairs: PairedPass[]
  queueDepth: number
  currentSpindleNumber: number | null
  health: { sourceOnline: boolean; processedOnline: boolean }
}

interface ProductionSession {
  session_id: string
  shift_label: string | null
  shift_number: number | null
  start_time: string
  end_time: string | null
}

let lastLiveResponse: LiveResponse | null = null

/** Polls the same endpoint local-camera-grid.tsx uses for counts, but only
 *  reads processedSessions — the annotated track each camera published back
 *  by the GPU inference worker, once it has one. */
function useProcessedSessions(): Record<string, ProcessedSession> {
  const [sessions, setSessions] = useState<Record<string, ProcessedSession>>(
    () => lastLiveResponse?.processedSessions ?? {}
  )

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

function useLiveInference(): LiveResponse | null {
  const [live, setLive] = useState<LiveResponse | null>(() => lastLiveResponse)

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      try {
        const response = await fetch('/api/inference/live', { cache: 'no-store' })
        if (!response.ok) return
        const body: LiveResponse = await response.json()
        lastLiveResponse = body
        if (!disposed) setLive(body)
      } catch {
        // The next poll retries while the worker or network is unavailable.
      }
    }
    void poll()
    const timer = setInterval(poll, LIVE_POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  return live
}

/** The raw local feed — imperative because React has no `srcObject` prop.
 *  This IS the same MediaStream the publisher captured for Cloudflare, not a
 *  second getUserMedia call, so there is only ever one open camera handle. */
function CameraBox({
  camera,
  devices,
  isAdmin,
  processed,
  live,
  spindleNumber,
  onSelect,
  onToggle,
}: {
  camera: CameraPublishState
  devices: { deviceId: string; label: string }[]
  isAdmin: boolean
  processed?: ProcessedSession
  live?: CameraLive
  spindleNumber: number | null
  onSelect: (deviceId: string) => void
  onToggle: () => void
}) {
  const enabled = camera.phase === 'live' || camera.phase === 'starting'
  // Browser publishing alone is not enough. The AI worker must have decoded
  // and submitted at least one frame before any camera output is shown.
  const aiConnected =
    enabled &&
    Boolean(processed) &&
    live !== undefined &&
    live.framesReceived > 0 &&
    live.spindlePresent !== undefined
  const statusLabel =
    camera.phase === 'live'
      ? aiConnected
        ? 'AI CONNECTED'
        : 'AI WAITING'
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
            aiConnected
              ? 'bg-[#DCFCE7] text-[#166534]'
              : enabled
                ? 'bg-[#FEF3C7] text-[#92400E]'
                : 'bg-[#F1F5F9] text-[#64748B]'
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
        {aiConnected ? (
          <div className="absolute inset-0">
            <CameraTile
              camera={{ id: camera.cameraId, name: camera.name, location: camera.location }}
              cfSessionId={processed!.sessionId}
              cfTrackName={processed!.trackName}
            />
          </div>
        ) : camera.stream ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0F172A] text-center text-white">
            <Camera className="mb-3 h-8 w-8 text-[#94A3B8]" />
            <p className="text-sm font-semibold">Waiting for AI connection</p>
            <p className="mt-1 px-5 text-xs text-[#94A3B8]">
              The camera will appear after the AI worker receives its first frame.
            </p>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60">
            <VideoOff className="mb-2 h-8 w-8" />
            <p className="text-sm">Camera is OFF</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-[#E2E8F0] px-5 py-4">
        <div className="rounded-lg bg-[#F8FAFC] px-3 py-2">
          <p className="text-xs text-[#64748B]">Hot Wheels</p>
          <p className="text-2xl font-bold text-[#0F172A]">
            {live ? (live.spindlePresent ? live.intervalCount : live.lastVisitCount ?? '-') : '-'}
          </p>
          <p className="text-[11px] text-[#94A3B8]">
            {live?.spindlePresent ? 'spindle in view' : live ? 'last completed visit' : 'waiting for AI'}
          </p>
        </div>
        <div className="rounded-lg bg-[#F8FAFC] px-3 py-2">
          <p className="text-xs text-[#64748B]">Spindle number</p>
          <p className="text-2xl font-bold text-[#0F172A]">{spindleNumber ?? '-'}</p>
          <p className="text-[11px] text-[#94A3B8]">current queue position</p>
        </div>
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
  const live = useLiveInference()
  const latestPair = live?.recentPairs?.[0] ?? null
  const [session, setSession] = useState<ProductionSession | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    let disposed = false
    const fetchActiveSession = async () => {
      try {
        const response = await fetch('/api/sessions?active=true', { cache: 'no-store' })
        const body = await response.json()
        if (!disposed && response.ok) {
          setSession(body.data?.[0] ?? null)
        }
      } catch {
        // The next poll retries while the API is unavailable.
      } finally {
        if (!disposed) setSessionLoading(false)
      }
    }

    void fetchActiveSession()
    const timer = setInterval(fetchActiveSession, 5000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  const handleStartSession = async () => {
    setActionLoading(true)
    try {
      const response = await fetch('/api/sessions', { method: 'POST' })
      const body = await response.json()
      if (response.ok) setSession(body.data)
    } finally {
      setActionLoading(false)
    }
  }

  const handleEndSession = async () => {
    if (!session) return
    setActionLoading(true)
    try {
      const response = await fetch(`/api/sessions/${session.session_id}`, {
        method: 'PATCH',
      })
      if (response.ok) setSession(null)
    } finally {
      setActionLoading(false)
    }
  }

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
          {session && (
            <p className="mt-1 text-sm font-medium text-[#0EA5E9]">
              {session.shift_label ?? `Shift ${session.shift_number}`}
              {' • '}
              {new Date(session.start_time).toLocaleDateString('en-US', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!session ? (
            <Button
              variant="success"
              size="md"
              loading={sessionLoading || actionLoading}
              onClick={() => void handleStartSession()}
              className="h-10 rounded-md px-5"
            >
              START OPERATION
            </Button>
          ) : (
            <>
              <Button
                variant="outline-danger"
                size="md"
                loading={actionLoading}
                onClick={() => void handleEndSession()}
                className="h-10 rounded-md px-5"
              >
                STOP
              </Button>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-[#22C55E]" />
                <span className="text-xs font-semibold text-[#22C55E]">LIVE</span>
              </div>
            </>
          )}
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

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-[#BAE6FD] bg-[#F0F9FF] px-4 py-3 text-sm text-[#075985]">
        <span>Source: {live?.health.sourceOnline ? 'connected' : 'offline'}</span>
        <span>AI inference: {live?.health.processedOnline ? 'running' : 'waiting for decoded frames'}</span>
        <span>Spindles waiting for exit: {live?.queueDepth ?? 0}</span>
        <span>
          Latest spindle: {latestPair ? `#${latestPair.spindleNumber} (${latestPair.entryCount} Hot Wheels)` : '-'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {snapshot.cameras.map((camera) => (
          <CameraBox
            key={camera.cameraId}
            camera={camera}
            devices={snapshot.devices}
            isAdmin={isAdmin}
            processed={processedSessions[camera.cameraId]}
            live={live?.cameras?.[camera.cameraId]}
            spindleNumber={
              live?.cameras?.[camera.cameraId]?.spindlePresent
                ? live.currentSpindleNumber ?? latestPair?.spindleNumber ?? null
                : latestPair?.spindleNumber ?? null
            }
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
