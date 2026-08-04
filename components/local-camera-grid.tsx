'use client'

import { useEffect, useState } from 'react'

import CameraTile from '@/components/camera-tile'

interface CameraConfig {
  id: string
  name: string
  location: string
}

interface LocalCameraGridProps {
  cameras: CameraConfig[]
}

interface CameraLive {
  spindlePresent: boolean
  intervalCount: number
  lastVisitCount: number | null
  lastSampleAt: number | null
  framesReceived: number
}

interface PairedPass {
  spindlePassId: string
  entryCount: number
  exitCount: number
  mismatchDelta: number
  status: 'matched' | 'mismatched'
  exitTime: number
}

interface LiveResponse {
  entryCameraId: string
  exitCameraId: string
  // Each camera has its own Cloudflare session — cameras never share one.
  processedSessions: Record<string, { sessionId: string; trackName: string }>
  cameras: Record<string, CameraLive>
  recentPairs: PairedPass[]
  queueDepth: number
  health: { sourceOnline: boolean; processedOnline: boolean }
}

export default function LocalCameraGrid({ cameras }: LocalCameraGridProps) {
  const [live, setLive] = useState<LiveResponse | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const resp = await fetch('/api/inference/live', { cache: 'no-store' })
        if (!resp.ok) return
        const data: LiveResponse = await resp.json()
        if (!cancelled) setLive(data)
      } catch {
        // Pipeline not up yet; the next tick will pick it up.
      }
    }

    poll()
    const id = setInterval(poll, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const latestPair = live?.recentPairs?.[0] ?? null

  // Counts are rendered only here, never on the tiles: per-tile numbers invite
  // being read as a running total when they are really two observations of the
  // same spindle that are supposed to agree.
  const countFor = (cameraId: string): number | null => {
    const cam = live?.cameras?.[cameraId]
    if (!cam) return null
    return cam.spindlePresent ? cam.intervalCount : cam.lastVisitCount
  }

  return (
    <div>
      <div className="mb-6 rounded-xl border border-[#BAE6FD] bg-[#F0F9FF] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0369A1]">
              Latest spindle pass
            </p>
            <p className="mt-1 text-4xl font-bold text-[#0C4A6E]">
              {latestPair ? latestPair.entryCount : '-'}
              {latestPair && latestPair.mismatchDelta !== 0 && (
                <span className="ml-3 text-2xl font-semibold text-[#B91C1C]">
                  {latestPair.mismatchDelta > 0 ? '+' : ''}
                  {latestPair.mismatchDelta}
                </span>
              )}
            </p>
            <p className="mt-1 text-sm text-[#0369A1]">
              {latestPair ? (
                <>
                  {latestPair.status === 'matched' ? 'Matched' : 'Mismatched'} — entry{' '}
                  {latestPair.entryCount}, exit {latestPair.exitCount} at{' '}
                  {new Date(latestPair.exitTime).toLocaleTimeString()}
                </>
              ) : (
                'Waiting for a spindle to pass both cameras…'
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {cameras.map((camera) => {
              const cam = live?.cameras?.[camera.id]
              const count = countFor(camera.id)
              return (
                <div key={camera.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-[#64748B]">{camera.name}</p>
                  <p className="text-xl font-bold text-[#0F172A]">{count ?? '-'}</p>
                  <p className="text-[11px] text-[#94A3B8]">
                    {cam?.spindlePresent ? 'spindle in view' : 'no spindle'}
                  </p>
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-[#BAE6FD] pt-3 text-xs text-[#075985]">
          <span>Cameras: {live?.health.sourceOnline ? 'streaming' : 'offline'}</span>
          <span>Inference: {live?.health.processedOnline ? 'running' : 'offline'}</span>
          <span>Awaiting exit: {live?.queueDepth ?? 0}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {cameras.map((camera) => {
          const processed = live?.processedSessions?.[camera.id]
          return (
            <CameraTile
              // Keyed on the session so a new Colab run remounts the tile
              // with a clean PeerConnection and connection status, rather
              // than carrying the previous session's state across.
              key={`${camera.id}:${processed?.sessionId ?? 'none'}`}
              camera={camera}
              cfSessionId={processed?.sessionId}
              cfTrackName={processed?.trackName}
            />
          )
        })}
      </div>
    </div>
  )
}
