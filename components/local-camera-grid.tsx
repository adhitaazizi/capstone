'use client'

import { useEffect, useRef, useState } from 'react'

import CameraTile from '@/components/camera-tile'

interface CameraConfig {
  id: string
  name: string
  location: string
}

interface LocalCameraGridProps {
  cameras: CameraConfig[]
}

interface RotationResult {
  rotationNumber: number
  counts: Record<string, { count: number; detections: unknown[] }>
  updatedAt: string
}

interface CloudflareSession {
  processed_session_id?: string
  processed_tracks?: Record<string, string>
}

export default function LocalCameraGrid({ cameras }: LocalCameraGridProps) {
  const [rotationResult, setRotationResult] = useState<RotationResult | null>(null)
  const [cfSession, setCfSession] = useState<CloudflareSession>({})
  const lastRotationNumberRef = useRef(0)

  // Poll edge worker for Colab inference results
  useEffect(() => {
    const poll = async () => {
      try {
        const resp = await fetch('/api/edge/spindle_count', { cache: 'no-store' })
        const data = await resp.json()
        if (data.rotation_number > lastRotationNumberRef.current) {
          lastRotationNumberRef.current = data.rotation_number
          setRotationResult({
            rotationNumber: data.rotation_number,
            counts: data.counts ?? {},
            updatedAt: data.updated_at ?? '',
          })
        }
      } catch {
        // edge worker not reachable yet
      }
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [])

  // Poll edge worker for the Cloudflare processed session info
  useEffect(() => {
    const poll = async () => {
      try {
        const resp = await fetch('/api/edge/cloudflare_session', { cache: 'no-store' })
        const data: CloudflareSession = await resp.json()
        if (data.processed_session_id) {
          setCfSession(data)
        }
      } catch {
        // edge worker not reachable yet
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  const maxCount = rotationResult
    ? Math.max(...cameras.map((c) => rotationResult.counts[c.id]?.count ?? 0))
    : null

  return (
    <div>
      {/* Shared spindle result */}
      <div className="mb-6 rounded-xl border border-[#BAE6FD] bg-[#F0F9FF] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0369A1]">
              Shared spindle result
            </p>
            <p className="mt-1 text-4xl font-bold text-[#0C4A6E]">
              {maxCount !== null ? maxCount : '-'}
            </p>
            <p className="mt-1 text-sm text-[#0369A1]">
              {rotationResult
                ? `Rotation #${rotationResult.rotationNumber} — updated at ${new Date(
                    rotationResult.updatedAt
                  ).toLocaleTimeString()}`
                : 'Waiting for first rotation to complete…'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {cameras.map((camera) => (
              <div key={camera.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                <p className="text-xs text-[#64748B]">{camera.name}</p>
                <p className="text-xl font-bold text-[#0F172A]">
                  {rotationResult?.counts[camera.id]?.count ?? '-'}
                </p>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-4 border-t border-[#BAE6FD] pt-3 text-xs text-[#075985]">
          Inference runs in Colab via Cloudflare Realtime. Results posted back here after each rotation.
        </p>
      </div>

      {/* Camera grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {cameras.map((camera) => (
          <CameraTile
            key={camera.id}
            camera={{ id: camera.id, name: camera.name, location: camera.location }}
            cfSessionId={cfSession.processed_session_id}
            cfTrackName={cfSession.processed_tracks?.[camera.id]}
            detectionCount={rotationResult?.counts[camera.id]?.count}
          />
        ))}
      </div>
    </div>
  )
}
