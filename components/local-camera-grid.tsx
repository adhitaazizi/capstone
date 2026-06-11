'use client'

import { useState } from 'react'

import CameraTile from '@/components/camera-tile'

interface CameraConfig {
  id: string
  name: string
  location: string
  streamUrl: string
}

interface LocalCameraGridProps {
  cameras: CameraConfig[]
}

type PermissionState = 'idle' | 'requesting' | 'granted' | 'denied'

export default function LocalCameraGrid({ cameras }: LocalCameraGridProps) {
  const [deviceIds, setDeviceIds] = useState<(string | null)[]>([])
  const [permissionState, setPermissionState] = useState<PermissionState>('idle')

  const connectCameras = async () => {
    setPermissionState('requesting')
    let tempStream: MediaStream | null = null

    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      tempStream.getTracks().forEach((t) => t.stop())
    } catch {
      setPermissionState('denied')
      return
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices
        .filter((d) => d.kind === 'videoinput' && d.deviceId)
        .map((d) => d.deviceId)
      setDeviceIds(videoDevices)
      setPermissionState('granted')
    } catch {
      setPermissionState('denied')
    }
  }

  return (
    <div>
      {permissionState !== 'granted' && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-[#E2E8F0] bg-white px-4 py-3">
          {permissionState === 'denied' ? (
            <p className="text-sm text-red-500">
              Camera permission denied. Allow camera access in your browser settings and try again.
            </p>
          ) : (
            <>
              <p className="text-sm text-[#64748B]">
                {permissionState === 'requesting'
                  ? 'Requesting camera access…'
                  : 'Connect your cameras to view live feeds.'}
              </p>
              <button
                onClick={connectCameras}
                disabled={permissionState === 'requesting'}
                className="ml-auto shrink-0 rounded-md bg-[#2563EB] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                {permissionState === 'requesting' ? 'Connecting…' : 'Connect Cameras'}
              </button>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {cameras.map((camera, index) => (
          <CameraTile
            key={camera.id}
            camera={{ id: camera.id, name: camera.name, location: camera.location }}
            streamUrl={camera.streamUrl}
            localDeviceId={permissionState === 'granted' ? (deviceIds[index] ?? null) : null}
            preferLocal={permissionState === 'granted'}
          />
        ))}
      </div>
    </div>
  )
}
