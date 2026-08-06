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
  /** Cameras whose detections are actually being counted right now. */
  counting: { active: boolean; cameras: string[] }
  health: { sourceOnline: boolean; processedOnline: boolean }
}

/**
 * One poll for everything this page needs.
 *
 * Deliberately a single request rather than one hook per concern: the tiles,
 * the counts, and the health strip all describe the same instant, and two
 * independent polls of the same endpoint would let them disagree by up to a
 * full interval — a tile reading AI CONNECTED beside a count that had not
 * caught up yet.
 */
function useLiveInference(): LiveResponse | null {
  const [live, setLive] = useState<LiveResponse | null>(null)

  useEffect(() => {
    let disposed = false

    const poll = async () => {
      try {
        const response = await fetch('/api/inference/live', { cache: 'no-store' })
        if (!response.ok) return
        const body: LiveResponse = await response.json()
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

function CameraBox({
  camera,
  devices,
  isAdmin,
  processed,
  live,
  counting,
  spindleNumber,
  onSelect,
  onToggle,
}: {
  camera: CameraPublishState
  devices: { deviceId: string; label: string }[]
  isAdmin: boolean
  processed?: ProcessedSession
  live?: CameraLive
  /** True once this camera's detections are being counted, not merely sent. */
  counting: boolean
  spindleNumber: number | null
  onSelect: (deviceId: string) => void
  onToggle: () => void
}) {
  const enabled = camera.phase === 'live' || camera.phase === 'starting'

  /**
   * Derived from the server's counting gate, not from `framesReceived > 0`.
   *
   * The two look interchangeable and are not: frames are only ever counted
   * while a tile is decoding the annotated track, so gating the *tile* on a
   * nonzero frame count would deadlock — the tile would wait for counts that
   * cannot start until the tile is mounted and decoding. Reading the gate
   * instead says exactly what the badge claims: this camera's detections are
   * being counted right now.
   */
  const aiConnected = enabled && counting

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

  const hotWheels = live
    ? live.spindlePresent
      ? live.intervalCount
      : live.lastVisitCount ?? '-'
    : '-'

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

      {/* The annotated track only — no raw local preview.
          A local preview proves a webcam is on, which is the least interesting
          thing that can be true here, and it did active harm: an operator
          watching their own face had no way to tell whether Cloudflare, the
          GPU worker, or the annotated track had fallen over. The tile is
          mounted for the whole time the camera is publishing, because its
          decoded frames are what permit counting server-side; while it has
          none it shows its own spinner. */}
      <div className="relative aspect-video bg-[#1E293B]">
        {enabled ? (
          <div className="absolute inset-0">
            <CameraTile
              // Keyed on the session so a new inference-worker run remounts
              // the tile with a clean PeerConnection and status rather than
              // carrying the previous session's state across.
              key={processed?.sessionId ?? 'none'}
              camera={{ id: camera.cameraId, name: camera.name, location: camera.location }}
              cfSessionId={processed?.sessionId}
              cfTrackName={processed?.trackName}
              // /cameras is the surface that permits counting. The tile
              // heartbeats only while frames actually decode.
              reportConsumption
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60">
            <VideoOff className="mb-2 h-8 w-8" />
            <p className="text-sm">Camera is OFF</p>
            <p className="mt-1 text-xs text-white/40">
              Counting is paused until this camera is on.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-[#E2E8F0] px-5 py-4">
        <div className="rounded-lg bg-[#F8FAFC] px-3 py-2">
          <p className="text-xs text-[#64748B]">Hot Wheels</p>
          <p className="text-2xl font-bold text-[#0F172A]">{aiConnected ? hotWheels : '-'}</p>
          <p className="text-[11px] text-[#94A3B8]">
            {!aiConnected
              ? 'waiting for AI'
              : live?.spindlePresent
                ? 'spindle in view'
                : 'last completed visit'}
          </p>
        </div>
        <div className="rounded-lg bg-[#F8FAFC] px-3 py-2">
          <p className="text-xs text-[#64748B]">Spindle number</p>
          <p className="text-2xl font-bold text-[#0F172A]">
            {aiConnected ? spindleNumber ?? '-' : '-'}
          </p>
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
  const live = useLiveInference()
  const latestPair = live?.recentPairs?.[0] ?? null

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
            Counting runs only while this page is showing the annotated stream.
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

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-[#BAE6FD] bg-[#F0F9FF] px-4 py-3 text-sm text-[#075985]">
        <span>Source: {live?.health.sourceOnline ? 'connected' : 'offline'}</span>
        <span>
          AI inference:{' '}
          {live?.health.processedOnline ? 'running' : 'waiting for decoded frames'}
        </span>
        <span>Counting: {live?.counting.active ? 'running' : 'paused'}</span>
        <span>Spindles waiting for exit: {live?.queueDepth ?? 0}</span>
        <span>
          Latest spindle:{' '}
          {latestPair
            ? `#${latestPair.spindleNumber} (${latestPair.entryCount} Hot Wheels)`
            : '-'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {snapshot.cameras.map((camera) => (
          <CameraBox
            key={camera.cameraId}
            camera={camera}
            devices={snapshot.devices}
            isAdmin={isAdmin}
            processed={live?.processedSessions?.[camera.cameraId]}
            live={live?.cameras?.[camera.cameraId]}
            counting={live?.counting.cameras.includes(camera.cameraId) ?? false}
            // The spindle in flight while one is in view; otherwise the last
            // one that completed, so the tile does not blank between spindles.
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
