'use client'

import { useCallback, useEffect, useState } from 'react'
import { Camera, Check, Power, RefreshCw, VideoOff } from 'lucide-react'

import Badge from '@/components/ui/badge'
import Button from '@/components/ui/button'
import { useSession } from '@/hooks/use-session'

type Checkpoint = 'entry' | 'exit' | null

interface LocalCamera {
  deviceId: string
  label: string
  groupId: string
  checkpoint: Checkpoint
  enabled: boolean
}

const STORAGE_KEY = 'spraycount.local-camera-config'

function checkpointLabel(checkpoint: Checkpoint): string {
  if (checkpoint === 'entry') return 'Entry checkpoint'
  if (checkpoint === 'exit') return 'Exit checkpoint'
  return 'Not assigned'
}

function mergeStoredCamera(camera: MediaDeviceInfo, stored: LocalCamera | undefined): LocalCamera {
  return {
    deviceId: camera.deviceId,
    label: camera.label || stored?.label || 'Laptop camera',
    groupId: camera.groupId,
    checkpoint: stored?.checkpoint ?? null,
    enabled: stored?.enabled ?? false,
  }
}

export default function DevicesPage() {
  const { isLoading: authLoading, isAdmin } = useSession()
  const [cameras, setCameras] = useState<LocalCamera[]>([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const readStored = (): LocalCamera[] => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as LocalCamera[]) : []
    } catch {
      return []
    }
  }

  const persist = (next: LocalCamera[]) => {
    setCameras(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  const detectCameras = useCallback(async () => {
    setDetecting(true)
    setError(null)
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error('This browser does not support local camera detection.')
      }

      // Permission is needed before browsers expose useful camera labels.
      if (navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        stream.getTracks().forEach((track) => track.stop())
      }

      const devices = await navigator.mediaDevices.enumerateDevices()
      const stored = readStored()
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')
      const next = videoDevices.map((device) =>
        mergeStoredCamera(device, stored.find((item) => item.deviceId === device.deviceId))
      )

      setCameras(next)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      if (next.length === 0) setError('No camera is connected to this laptop.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to detect laptop cameras.')
      setCameras([])
    } finally {
      setDetecting(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading) void detectCameras()
  }, [authLoading, detectCameras])

  const assignCamera = (deviceId: string, checkpoint: Checkpoint) => {
    const next = cameras.map((camera) => {
      if (camera.deviceId === deviceId) {
        return { ...camera, checkpoint, enabled: checkpoint !== null ? camera.enabled : false }
      }
      if (checkpoint !== null && camera.checkpoint === checkpoint) {
        return { ...camera, checkpoint: null, enabled: false }
      }
      return camera
    })
    persist(next)
  }

  const toggleCamera = (camera: LocalCamera) => {
    if (!camera.enabled && camera.checkpoint === null) {
      setError('Assign the camera to Entry or Exit before turning it ON.')
      return
    }
    persist(
      cameras.map((item) =>
        item.deviceId === camera.deviceId ? { ...item, enabled: !item.enabled } : item
      )
    )
    setError(null)
  }

  if (loading || authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">Device Management</h1>
          <p className="mt-1 text-[#64748B]">
            Cameras detected on this laptop
          </p>
        </div>
        {isAdmin && (
          <Button variant="secondary" loading={detecting} onClick={() => void detectCameras()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Detect cameras
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          {error}
        </div>
      )}

      {cameras.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {cameras.map((camera) => (
            <div key={camera.deviceId} className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
              <div className="mb-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#0EA5E9]/10">
                    <Camera className="h-5 w-5 text-[#0EA5E9]" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-[#1E293B]">{camera.label}</h3>
                    <p className="text-xs text-[#94A3B8]">Local laptop camera</p>
                  </div>
                </div>
                <Badge variant={camera.enabled ? 'success' : 'warning'}>
                  {camera.enabled ? 'ON' : 'OFF'}
                </Badge>
              </div>

              <div className="space-y-3 text-sm text-[#64748B]">
                <div className="flex items-center justify-between">
                  <span>Checkpoint</span>
                  <span className="font-medium text-[#334155]">{checkpointLabel(camera.checkpoint)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Device ID</span>
                  <span className="max-w-[150px] truncate font-mono text-xs text-[#94A3B8]" title={camera.deviceId}>
                    {camera.deviceId || 'default'}
                  </span>
                </div>
              </div>

              {isAdmin && (
                <div className="mt-5 space-y-3 border-t border-[#F1F5F9] pt-4">
                  <label className="block text-sm font-medium text-[#334155]">
                    Use for checkpoint
                    <select
                      className="mt-1 w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-sm outline-none focus:border-[#0EA5E9] focus:ring-2 focus:ring-[#0EA5E9]/20"
                      value={camera.checkpoint ?? ''}
                      onChange={(event) =>
                        assignCamera(camera.deviceId, (event.target.value || null) as Checkpoint)
                      }
                    >
                      <option value="">Not assigned</option>
                      <option value="entry">Entry checkpoint</option>
                      <option value="exit">Exit checkpoint</option>
                    </select>
                  </label>
                  <Button
                    className="w-full"
                    variant={camera.enabled ? 'danger' : 'success'}
                    onClick={() => toggleCamera(camera)}
                  >
                    <Power className="mr-2 h-4 w-4" />
                    {camera.enabled ? 'Turn camera OFF' : 'Turn camera ON'}
                  </Button>
                </div>
              )}

              {!isAdmin && (
                <div className="mt-5 flex items-center gap-2 border-t border-[#F1F5F9] pt-4 text-sm text-[#64748B]">
                  {camera.enabled ? <Check className="h-4 w-4 text-[#16A34A]" /> : <VideoOff className="h-4 w-4" />}
                  {camera.enabled ? 'Configured for production' : 'Not in use'}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-[#E2E8F0] bg-white p-6 text-center">
          <div>
            <VideoOff className="mx-auto h-8 w-8 text-[#94A3B8]" />
            <p className="mt-3 text-[#64748B]">No laptop camera detected</p>
          </div>
        </div>
      )}
    </div>
  )
}
