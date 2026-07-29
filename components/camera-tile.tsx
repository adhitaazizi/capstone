'use client'

import React, { useEffect, useRef, useState } from 'react'
import Badge from '@/components/ui/badge'

interface Camera {
  id: string
  name: string
  location: string
}

interface Detection {
  id?: number
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
  whepUrl?: string
  videoSrc?: string
  localDeviceId?: string | null
  preferLocal?: boolean
  onDetection?: (cameraId: string, count: number, confidenceAvg: number, detections: Detection[]) => void
}

// Track colors matching the server-side palette
const TRACK_COLORS = [
  '#22c55e', '#fb923c', '#3b82f6', '#ef4444',
  '#22d3ee', '#a855f7', '#facc15', '#f472b6',
]

export default function CameraTile({
  camera,
  streamUrl,
  whepUrl,
  videoSrc,
  localDeviceId,
  preferLocal = false,
  onDetection,
}: CameraTileProps) {
  const useLocalVideo = Boolean(videoSrc) && !preferLocal
  const useWebRtc    = Boolean(whepUrl) && !preferLocal && !useLocalVideo
  const imgRef        = useRef<HTMLImageElement>(null)
  const videoRef      = useRef<HTMLVideoElement>(null)
  const overlayRef    = useRef<HTMLCanvasElement>(null)

  const [status, setStatus]             = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [streamAttempt, setStreamAttempt] = useState(0)
  const [detections, setDetections]     = useState<Detection[]>([])
  const lastSavedRef                    = useRef(0)

  // ── Local camera stream ────────────────────────────────────────────────────
  useEffect(() => {
    if (!preferLocal) return
    if (!localDeviceId) { setStatus('offline'); return }
    const video = videoRef.current
    if (!video || !navigator.mediaDevices?.getUserMedia) { setStatus('offline'); return }
    let stream: MediaStream | null = null
    let disposed = false
    const start = async () => {
      try {
        setStatus('connecting')
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: localDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        })
        if (disposed) { stream.getTracks().forEach((t) => t.stop()); return }
        video.srcObject = stream
        await video.play()
        if (!disposed) setStatus('online')
      } catch { if (!disposed) setStatus('offline') }
    }
    void start()
    return () => {
      disposed = true
      stream?.getTracks().forEach((t) => t.stop())
      if (video.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
    }
  }, [localDeviceId, preferLocal])

  // ── WebRTC WHEP ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!useWebRtc || !whepUrl) return
    let pc: RTCPeerConnection | null = null
    let disposed = false
    const connect = async () => {
      setStatus('connecting')
      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        if (disposed) return
        const v = videoRef.current
        if (v) { v.srcObject = e.streams[0]; v.play().catch(() => {}); setStatus('online') }
      }
      pc.onconnectionstatechange = () => {
        if (disposed) return
        if (pc?.connectionState === 'connected') setStatus('online')
        else if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') setStatus('offline')
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const res = await fetch(whepUrl, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp })
      if (!res.ok) { if (!disposed) setStatus('offline'); return }
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    }
    connect().catch(() => { if (!disposed) setStatus('offline') })
    return () => { disposed = true; pc?.close(); const v = videoRef.current; if (v) v.srcObject = null }
  }, [useWebRtc, whepUrl])

  // ── Static video file ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!useLocalVideo || !videoSrc) return
    const v = videoRef.current
    if (!v) return
    v.src = videoSrc; v.loop = true; v.muted = true
    setStatus('connecting')
    v.play().then(() => setStatus('online')).catch(() => setStatus('offline'))
    return () => { v.src = '' }
  }, [useLocalVideo, videoSrc])

  // ── MJPEG stream ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (preferLocal || useWebRtc || useLocalVideo) return
    const img = imgRef.current
    if (!img) return
    setStatus('connecting')
    let offlineTimer: NodeJS.Timeout | null = setTimeout(() => setStatus('offline'), 3000)
    let retryTimer:  NodeJS.Timeout | null = null
    const clear = () => { if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null } }
    img.onload  = () => { setStatus('online'); clear() }
    img.onerror = () => {
      clear(); setStatus('offline')
      retryTimer = setTimeout(() => setStreamAttempt((a) => a + 1), 3000)
    }
    return () => { clear(); if (retryTimer) clearTimeout(retryTimer); img.onload = null; img.onerror = null }
  }, [streamUrl, preferLocal, streamAttempt])

  // ── Poll edge-worker tracked detections ────────────────────────────────────
  useEffect(() => {
    if (status !== 'online') { setDetections([]); return }
    let stopped = false
    const poll = async () => {
      if (stopped) return
      try {
        const res = await fetch(`/api/edge/detections/${camera.id}`, { cache: 'no-store' })
        if (stopped || !res.ok) return
        const data = await res.json()
        const dets: Detection[] = data.detections ?? []
        setDetections(dets)
        const confidenceAvg = dets.length
          ? dets.reduce((s, d) => s + d.confidence, 0) / dets.length : 0
        onDetection?.(camera.id, dets.length, confidenceAvg, dets)
        if (dets.length > 0) {
          const now = Date.now()
          if (now - lastSavedRef.current >= 3000) {
            lastSavedRef.current = now
            void fetch('/api/detections', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ camera_code: camera.id, count: dets.length, confidence_avg: Math.round(confidenceAvg * 1000) / 1000, bboxes: dets }),
            })
          }
        }
      } catch { /* network blip — keep last boxes showing */ }
    }
    const interval = setInterval(poll, 100)
    return () => { stopped = true; clearInterval(interval) }
  }, [camera.id, onDetection, status])

  // ── Draw bounding boxes on canvas overlay ──────────────────────────────────
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas) return
    const displayW = canvas.offsetWidth
    const displayH = canvas.offsetHeight
    if (!displayW || !displayH) return
    canvas.width  = displayW
    canvas.height = displayH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, displayW, displayH)
    if (!detections.length) return

    // Edge-worker inference runs on 640×640 frames
    const srcW = 640, srcH = 640
    const scaleX = displayW / srcW
    const scaleY = displayH / srcH

    detections.forEach((det) => {
      const color = TRACK_COLORS[(det.id ?? 0) % TRACK_COLORS.length]
      const x = (det.x - det.width  / 2) * scaleX
      const y = (det.y - det.height / 2) * scaleY
      const w = det.width  * scaleX
      const h = det.height * scaleY

      ctx.strokeStyle = color
      ctx.lineWidth   = 2
      ctx.strokeRect(x, y, w, h)

      const label = `${det.class} ${Math.round(det.confidence * 100)}%`
      ctx.font = 'bold 12px sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = color
      ctx.fillRect(x, y - 20, tw + 8, 20)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 4, y - 5)
    })
  }, [detections])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#1E293B]">
      {/* Local / WebRTC video */}
      <video
        ref={videoRef}
        className={`h-full w-full object-cover ${preferLocal || useWebRtc || useLocalVideo ? 'block' : 'hidden'}`}
        autoPlay muted playsInline
      />

      {/* MJPEG stream from edge-worker (raw, fast) */}
      <img
        ref={imgRef}
        src={!preferLocal && !useWebRtc && !useLocalVideo ? `${streamUrl}?attempt=${streamAttempt}` : undefined}
        alt={camera.name}
        className={`h-full w-full object-cover ${!preferLocal && !useWebRtc && !useLocalVideo ? 'block' : 'hidden'}`}
      />

      {/* Bounding box overlay — drawn client-side from edge-worker tracked detections */}
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Header */}
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

      {/* Status bar */}
      {status === 'online' && (
        <div className="absolute bottom-0 left-0 w-full bg-black/50 px-3 py-1 text-xs text-white">
          {detections.length > 0
            ? <span className="text-green-400">✓ {detections.length} tracked</span>
            : <span className="text-gray-300">● Detecting…</span>
          }
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
              {status === 'connecting' ? 'Establishing stream…'
                : preferLocal ? 'No camera available for this slot.' : 'Stream unavailable.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
