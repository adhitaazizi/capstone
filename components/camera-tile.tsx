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
  streamUrl: string
  localDeviceId?: string | null
  preferLocal?: boolean
}

export default function CameraTile({
  camera,
  streamUrl,
  localDeviceId,
  preferLocal = false,
}: CameraTileProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [fps, setFps] = useState(0)
  const [connectionLost, setConnectionLost] = useState(false)

  const frameCountRef = useRef(0)
  const lastPixelRef = useRef<string | null>(null)
  const connectionLostTimerRef = useRef<NodeJS.Timeout | null>(null)
  const statusRef = useRef(status)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (!preferLocal) {
      return
    }

    if (!localDeviceId) {
      setStatus('offline')
      setConnectionLost(false)
      setFps(0)
      return
    }

    const video = videoRef.current
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      setStatus('offline')
      setConnectionLost(false)
      return
    }

    let stream: MediaStream | null = null
    let disposed = false

    const startStream = async () => {
      try {
        setStatus('connecting')
        setConnectionLost(false)

        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: localDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        })

        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        video.srcObject = stream
        await video.play()
        setStatus('online')
      } catch {
        if (!disposed) {
          setStatus('offline')
          setConnectionLost(false)
        }
      }
    }

    void startStream()

    return () => {
      disposed = true
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
      if (video.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((track) => track.stop())
        video.srcObject = null
      }
    }
  }, [localDeviceId, preferLocal])

  useEffect(() => {
    if (preferLocal) {
      return
    }

    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas) return

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    let fpsInterval: NodeJS.Timeout
    let heartbeatInterval: NodeJS.Timeout

    const clearConnectionTimer = () => {
      if (connectionLostTimerRef.current) {
        clearTimeout(connectionLostTimerRef.current)
        connectionLostTimerRef.current = null
      }
    }

    const handleLoad = () => {
      setStatus('online')
      setConnectionLost(false)
      clearConnectionTimer()
    }

    const handleError = () => {
      setStatus('offline')
      clearConnectionTimer()
      connectionLostTimerRef.current = setTimeout(() => {
        if (statusRef.current === 'offline') {
          setConnectionLost(true)
        }
      }, 5000)
    }

    img.addEventListener('load', handleLoad)
    img.addEventListener('error', handleError)

    fpsInterval = setInterval(() => {
      setFps(frameCountRef.current)
      frameCountRef.current = 0
    }, 1000)

    heartbeatInterval = setInterval(() => {
      if (!img.complete || img.naturalWidth === 0) return

      try {
        canvas.width = 1
        canvas.height = 1
        ctx.drawImage(img, 0, 0, 1, 1)
        const pixel = ctx.getImageData(0, 0, 1, 1).data
        const pixelKey = `${pixel[0]},${pixel[1]},${pixel[2]}`

        if (lastPixelRef.current && lastPixelRef.current !== pixelKey) {
          frameCountRef.current++
          if (statusRef.current !== 'online') {
            setStatus('online')
            setConnectionLost(false)
            clearConnectionTimer()
          }
        }
        lastPixelRef.current = pixelKey
      } catch {
        lastPixelRef.current = null
      }
    }, 200)

    connectionLostTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'connecting') {
        setStatus('offline')
        setConnectionLost(true)
      }
    }, 5000)

    return () => {
      img.removeEventListener('load', handleLoad)
      img.removeEventListener('error', handleError)
      clearInterval(fpsInterval)
      clearInterval(heartbeatInterval)
      clearConnectionTimer()
    }
  }, [streamUrl, preferLocal])

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#1E293B]">
      <canvas ref={canvasRef} className="hidden" />
      <video
        ref={videoRef}
        className={`h-full w-full object-cover ${preferLocal ? 'block' : 'hidden'}`}
        autoPlay
        muted
        playsInline
      />
      <img
        ref={imgRef}
        src={streamUrl}
        alt={camera.name}
        className={`h-full w-full object-cover ${preferLocal ? 'hidden' : 'block'}`}
      />
      <div className="absolute left-0 top-0 w-full bg-linear-to-b from-black/60 to-transparent p-3">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white drop-shadow">
              {camera.name}
            </h3>
            <p className="text-xs text-white/80 drop-shadow">
              {camera.location}
            </p>
          </div>
          <Badge variant={status === 'online' ? 'success' : 'danger'}>
            {status === 'online' ? 'ONLINE' : 'OFFLINE'}
          </Badge>
        </div>
      </div>

      {fps > 0 && (
        <div className="absolute bottom-3 right-3 rounded bg-black/50 px-2 py-0.5 text-xs font-medium text-white">
          {fps} FPS
        </div>
      )}
      {connectionLost && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">Connection Lost</p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              Attempting to reconnect...
            </p>
          </div>
        </div>
      )}
      {!connectionLost && status === 'offline' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">Offline</p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              No camera connected for this slot.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
