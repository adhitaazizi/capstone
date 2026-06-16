'use client'

import React, { useEffect, useRef, useState } from 'react'
import Badge from '@/components/ui/badge'

interface Camera {
  id: string
  name: string
  location: string
}

interface Detection {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class: string
}

interface CameraTileProps {
  camera: Camera
  streamUrl: string
  localDeviceId?: string | null
  preferLocal?: boolean
  onDetection?: (cameraId: string, count: number, confidenceAvg: number) => void
}

export default function CameraTile({
  camera,
  streamUrl,
  localDeviceId,
  preferLocal = false,
  onDetection,
}: CameraTileProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [detections, setDetections] = useState<Detection[]>([])
  const [detectStatus, setDetectStatus] = useState<
    'idle' | 'running' | 'not_configured' | 'quota_exceeded' | 'error'
  >('idle')
  const detectingRef = useRef(false)
  const detectionBlockedRef = useRef(false)
  const lastSavedRef = useRef(0)

  // ── Local camera stream ────────────────────────────────────────────────────
  useEffect(() => {
    if (!preferLocal) return

    if (!localDeviceId) {
      setStatus('offline')
      return
    }

    const video = videoRef.current
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      setStatus('offline')
      return
    }

    let stream: MediaStream | null = null
    let disposed = false

    const startStream = async () => {
      try {
        setStatus('connecting')
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
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
        if (!disposed) {
          const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId
          if (activeDeviceId && activeDeviceId !== localDeviceId) {
            throw new Error('Browser opened a different camera than requested')
          }
          setStatus('online')
        }
      } catch {
        if (!disposed) {
          setStatus('offline')
        }
      }
    }

    void startStream()

    return () => {
      disposed = true
      if (stream) stream.getTracks().forEach((t) => t.stop())
      if (video.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
    }
  }, [localDeviceId, preferLocal])

  useEffect(() => {
    detectionBlockedRef.current = false
    setDetectStatus('idle')
  }, [localDeviceId])

  // ── MJPEG stream fallback ──────────────────────────────────────────────────
  useEffect(() => {
    if (preferLocal) return

    const img = imgRef.current
    if (!img) return

    let timer: NodeJS.Timeout | null = setTimeout(() => {
      setStatus('offline')
    }, 5000)

    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null }
    }

    img.onload = () => { setStatus('online'); clearTimer() }
    img.onerror = () => setStatus('offline')

    return () => {
      clearTimer()
      img.onload = null
      img.onerror = null
    }
  }, [streamUrl, preferLocal])

  // ── Detection loop (500 ms) ────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'online') {
      setDetections([])
      return
    }

    let stopped = false

    const detect = async () => {
      if (stopped || detectingRef.current || detectionBlockedRef.current) return

      const video = videoRef.current
      const img = imgRef.current
      const canvas = captureCanvasRef.current
      const source = preferLocal ? video : img
      const sourceWidth = preferLocal ? video?.videoWidth : img?.naturalWidth
      const sourceHeight = preferLocal ? video?.videoHeight : img?.naturalHeight
      if (!source || !canvas || !sourceWidth || !sourceHeight) return

      detectingRef.current = true
      canvas.width = sourceWidth
      canvas.height = sourceHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) { detectingRef.current = false; return }
      ctx.drawImage(source, 0, 0)

      const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
      try {
        setDetectStatus('running')
        const res = await fetch('/api/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 }),
        })
        if (!stopped) {
          const data = await res.json()
          const dets: Detection[] = data.detections ?? []
          const confidenceAvg = dets.length
            ? dets.reduce((sum, detection) => sum + detection.confidence, 0) / dets.length
            : 0
          setDetections(dets)
          onDetection?.(camera.id, dets.length, confidenceAvg)
          if (data.status === 'not_configured') setDetectStatus('not_configured')
          else if (data.errorCode === 'credit_cap_exceeded') {
            detectionBlockedRef.current = true
            setDetectStatus('quota_exceeded')
          }
          else if (data.status === 'error') setDetectStatus('error')
          else setDetectStatus('running')

          // Save to DB at most once every 3 seconds when something is detected
          if (dets.length > 0) {
            const now = Date.now()
            if (now - lastSavedRef.current >= 3000) {
              lastSavedRef.current = now
              void fetch('/api/detections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  camera_code: camera.id,
                  count: dets.length,
                  confidence_avg: Math.round(confidenceAvg * 1000) / 1000,
                  bboxes: dets,
                }),
              })
            }
          }
        }
      } catch {
        if (!stopped) setDetectStatus('error')
      } finally {
        detectingRef.current = false
      }
    }

    const interval = setInterval(detect, 500)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [camera.id, onDetection, preferLocal, status, streamUrl])

  // ── Draw bounding boxes ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = overlayCanvasRef.current
    const video = videoRef.current
    const img = imgRef.current
    if (!canvas) return

    const displayW = canvas.offsetWidth
    const displayH = canvas.offsetHeight
    canvas.width = displayW
    canvas.height = displayH

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, displayW, displayH)

    const sourceWidth = preferLocal ? video?.videoWidth : img?.naturalWidth
    const sourceHeight = preferLocal ? video?.videoHeight : img?.naturalHeight
    if (!detections.length || !sourceWidth || !sourceHeight) return

    const scaleX = displayW / sourceWidth
    const scaleY = displayH / sourceHeight

    detections.forEach((det) => {
      const x = (det.x - det.width / 2) * scaleX
      const y = (det.y - det.height / 2) * scaleY
      const w = det.width * scaleX
      const h = det.height * scaleY

      // Box
      ctx.strokeStyle = '#22C55E'
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, w, h)

      // Label background
      const label = `${det.class} ${Math.round(det.confidence * 100)}%`
      ctx.font = 'bold 13px sans-serif'
      const textW = ctx.measureText(label).width
      ctx.fillStyle = '#22C55E'
      ctx.fillRect(x, y - 20, textW + 8, 20)

      // Label text
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 4, y - 5)
    })
  }, [detections, preferLocal])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#1E293B]">
      {/* Hidden canvas for frame capture */}
      <canvas ref={captureCanvasRef} className="hidden" />

      {/* Local camera video */}
      <video
        ref={videoRef}
        className={`h-full w-full object-cover ${preferLocal ? 'block' : 'hidden'}`}
        autoPlay
        muted
        playsInline
      />

      {/* MJPEG stream image */}
      <img
        ref={imgRef}
        src={preferLocal ? undefined : streamUrl}
        alt={camera.name}
        className={`h-full w-full object-cover ${preferLocal ? 'hidden' : 'block'}`}
      />

      {/* Detection bounding box overlay */}
      <canvas
        ref={overlayCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Camera info header */}
      <div className="absolute left-0 top-0 w-full bg-linear-to-b from-black/60 to-transparent p-3">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white drop-shadow">{camera.name}</h3>
            <p className="text-xs text-white/80 drop-shadow">{camera.location}</p>
          </div>
          <div className="flex items-center gap-2">
            {detections.length > 0 && (
              <span className="rounded bg-green-500/80 px-2 py-0.5 text-xs font-semibold text-white">
                {detections.length} detected
              </span>
            )}
            <Badge variant={status === 'online' ? 'success' : 'danger'}>
              {status === 'online' ? 'ONLINE' : 'OFFLINE'}
            </Badge>
          </div>
        </div>
      </div>

      {/* Detection status bar */}
      {status === 'online' && (
        <div className="absolute bottom-0 left-0 w-full bg-black/50 px-3 py-1 text-xs text-white">
          {detectStatus === 'not_configured' && (
            <span className="text-yellow-400">⚠ Set ROBOFLOW_API_KEY in .env to enable detection</span>
          )}
          {detectStatus === 'error' && (
            <span className="text-red-400">✗ Detection API error — check server logs</span>
          )}
          {detectStatus === 'quota_exceeded' && (
            <span className="text-red-400">
              Roboflow credits exhausted. Detection paused until reload.
            </span>
          )}
          {detectStatus === 'running' && detections.length === 0 && (
            <span className="text-gray-300">● Detecting…</span>
          )}
          {detectStatus === 'running' && detections.length > 0 && (
            <span className="text-green-400">✓ {detections.length} object(s) detected</span>
          )}
        </div>
      )}

      {/* Offline overlay */}
      {status !== 'online' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-lg bg-[#1E293B] p-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-white">
              {status === 'connecting' ? 'Connecting…' : 'Offline'}
            </p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              {status === 'connecting'
                ? 'Establishing stream…'
                : preferLocal
                  ? 'No camera available for this slot.'
                  : 'Stream unavailable.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
