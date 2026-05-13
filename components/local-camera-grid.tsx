'use client'

import { useEffect, useState } from 'react'

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

export default function LocalCameraGrid({ cameras }: LocalCameraGridProps) {
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [localMode, setLocalMode] = useState(false)

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return
    }

    let isDisposed = false

    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (isDisposed) {
          return
        }

        const cameras = devices.filter((device) => device.kind === 'videoinput')
        setVideoInputs(cameras)
        setLocalMode(cameras.length > 0)
      } catch {
        if (!isDisposed) {
          setVideoInputs([])
          setLocalMode(false)
        }
      }
    }

    void loadDevices()
    navigator.mediaDevices.addEventListener?.('devicechange', loadDevices)

    return () => {
      isDisposed = true
      navigator.mediaDevices.removeEventListener?.('devicechange', loadDevices)
    }
  }, [])

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      {cameras.map((camera, index) => (
        <CameraTile
          key={camera.id}
          camera={{
            id: camera.id,
            name: camera.name,
            location: camera.location,
          }}
          streamUrl={camera.streamUrl}
          localDeviceId={videoInputs[index]?.deviceId ?? null}
          preferLocal={localMode}
        />
      ))}
    </div>
  )
}