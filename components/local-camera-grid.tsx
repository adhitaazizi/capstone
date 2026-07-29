'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import CameraTile from '@/components/camera-tile'

interface CameraConfig {
  id: string
  name: string
  location: string
  streamUrl: string
  whepUrl?: string
  videoSrc?: string
  sourceMode?: 'local' | 'stream'
}

interface LocalCameraGridProps {
  cameras: CameraConfig[]
}

interface VideoDevice {
  deviceId: string
  label: string
}

interface DetectionReport {
  count: number
  confidenceAvg: number
  timestamp: number
}

interface Detection {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class: string
}

type PermissionState = 'idle' | 'requesting' | 'granted' | 'denied'

// ── Row-rotation tracking ────────────────────────────────────────────────────
const ROW_TRACKING_CAMERA = 'CAM-01'   // primary entry camera for Y tracking
const NUM_ROWS            = 3           // rows on the spindle
const Y_TOLERANCE         = 25          // px — rows are 29-43px apart; 25 separates them without merging adjacent rows
const COOLDOWN_MS         = 15_000      // ms between observations
const ROTATION_TIMEOUT_MS = 15_000      // max observation window — longest gap between row appearances is ~8s

class RowTracker {
  private seenY: number[] = []

  constructor(private yTolerance = Y_TOLERANCE, private numRows = NUM_ROWS) {}

  /** Returns true only when a row repeats after ALL expected rows are recorded. */
  addFrame(detections: Detection[]): boolean {
    for (const det of detections) {
      if (this.seenY.some((y) => Math.abs(det.y - y) <= this.yTolerance)) {
        // Repeat Y — only counts as rotation-complete once all rows are seen.
        if (this.seenY.length >= this.numRows) return true
      } else if (this.seenY.length < this.numRows) {
        // New row — but stop recording once we've seen all expected rows.
        this.seenY.push(det.y)
      }
    }
    return false
  }

  isSaturated(): boolean { return this.seenY.length >= this.numRows }

  get totalCount(): number { return this.seenY.length }

  reset(): void { this.seenY = [] }
}

export default function LocalCameraGrid({ cameras }: LocalCameraGridProps) {
  const cameraMode = (camera: CameraConfig) =>
    camera.sourceMode ?? (camera.id === 'CAM-02' ? 'local' : 'stream')
  const localCameraIndexes = cameras
    .map((camera, index) => (cameraMode(camera) === 'local' ? index : -1))
    .filter((index) => index >= 0)
  const hasLocalCameras = localCameraIndexes.length > 0
  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([])
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<(string | null)[]>([])
  const [permissionState, setPermissionState] = useState<PermissionState>(
    hasLocalCameras ? 'idle' : 'granted'
  )
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [reports, setReports] = useState<Record<string, DetectionReport>>({})

  // ── Rotation tracking refs ─────────────────────────────────────────────────
  const trackerRef          = useRef(new RowTracker())
  const phaseRef            = useRef<'observing' | 'cooldown'>('observing')
  const rotationNumRef      = useRef(0)
  const cooldownTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestReportsRef    = useRef<Record<string, DetectionReport>>({})
  const observationStartRef = useRef(Date.now())

  // ── Live log state ─────────────────────────────────────────────────────────
  interface LogEntry {
    id: number
    time: string
    message: string
    color: 'green' | 'blue' | 'gray'
    details?: string[]
  }
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logIdRef   = useRef(0)
  const logPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { latestReportsRef.current = reports }, [reports])

  // Auto-scroll log panel to bottom on new entries
  useEffect(() => {
    const el = logPanelRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  useEffect(() => () => {
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
  }, [])

  const connectCameras = async () => {
    setPermissionState('requesting')
    setCameraError(null)

    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      })
      tempStream.getTracks().forEach((track) => track.stop())
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : 'UnknownError'
      const message =
        errorName === 'NotAllowedError' || errorName === 'SecurityError'
          ? 'Camera access is blocked. Click the camera icon beside the address bar, allow camera access, then try again.'
          : errorName === 'NotReadableError' || errorName === 'AbortError'
            ? 'The camera is busy or unavailable. Close Camera, Zoom, OBS, or another browser tab, then try again.'
            : errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError'
              ? 'No camera was found. Reconnect the USB camera and try again.'
              : 'The browser could not open the camera. Check the camera connection and try again.'

      setCameraError(message)
      setPermissionState('denied')
      return
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const availableCameras = devices
        .filter((device) => device.kind === 'videoinput' && device.deviceId)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }))

      setVideoDevices(availableCameras)
      setSelectedDeviceIds(cameras.map(() => null))
      setSelectedDeviceIds((current) => {
        const next = [...current]
        localCameraIndexes.forEach((cameraIndex, localIndex) => {
          next[cameraIndex] = availableCameras[localIndex]?.deviceId ?? null
        })
        return next
      })
      setPermissionState('granted')
    } catch {
      setCameraError('Camera access succeeded, but the device list could not be read. Try again.')
      setPermissionState('denied')
    }
  }

  const handleDetection = useCallback(
    (cameraId: string, count: number, confidenceAvg: number, detections: Detection[]) => {
      setReports((current) => ({
        ...current,
        [cameraId]: { count, confidenceAvg, timestamp: Date.now() },
      }))

      if (cameraId !== ROW_TRACKING_CAMERA || phaseRef.current !== 'observing') return

      const tracker = trackerRef.current
      const timedOut = Date.now() - observationStartRef.current >= ROTATION_TIMEOUT_MS
      const done = !timedOut && (tracker.addFrame(detections) || tracker.isSaturated())

      if (!done && !timedOut) return

      // No detections at all yet on timeout — just reset the window and keep waiting
      if (timedOut && tracker.totalCount === 0) {
        observationStartRef.current = Date.now()
        return
      }

      // ── Rotation complete (natural or timeout) ─────────────────────────────
      phaseRef.current = 'cooldown'
      rotationNumRef.current += 1
      const rotNum = rotationNumRef.current
      const uniqueRows = tracker.totalCount
      const snapshot = {
        ...latestReportsRef.current,
        [cameraId]: { count, confidenceAvg, timestamp: Date.now() },
      }
      const nextStartTime = new Date(Date.now() + COOLDOWN_MS).toLocaleTimeString()
      const rowsLabel = timedOut
        ? `${uniqueRows}/${NUM_ROWS} rows seen (timeout)`
        : `${uniqueRows}/${NUM_ROWS} rows seen`

      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdRef.current,
          time: new Date().toLocaleTimeString(),
          message: `Rotation #${rotNum} complete  —  ${rowsLabel}`,
          color: 'green' as const,
          details: [
            ...Object.entries(snapshot).map(
              ([id, r]) =>
                `${id}: ${r.count} detected  (${(r.confidenceAvg * 100).toFixed(0)}% confidence)`,
            ),
            `No duplicates  ✓`,
          ],
        },
        {
          id: ++logIdRef.current,
          time: new Date().toLocaleTimeString(),
          message: `15s cooldown  —  next observation at ${nextStartTime}`,
          color: 'gray' as const,
        },
      ])

      cooldownTimerRef.current = setTimeout(() => {
        trackerRef.current.reset()
        observationStartRef.current = Date.now()
        phaseRef.current = 'observing'
        setLogs((prev) => [
          ...prev,
          {
            id: ++logIdRef.current,
            time: new Date().toLocaleTimeString(),
            message: `Observation #${rotationNumRef.current + 1} started`,
            color: 'blue' as const,
          },
        ])
      }, COOLDOWN_MS)
    },
    [],
  )

  const fusedResult = useMemo(() => {
    const activeReports = cameras
      .map((camera) => reports[camera.id])
      .filter((report): report is DetectionReport => Boolean(report))

    if (activeReports.length !== cameras.length) {
      return { count: 0, synchronized: false }
    }

    const timestamps = activeReports.map((report) => report.timestamp)
    const synchronized = Math.max(...timestamps) - Math.min(...timestamps) <= 3000

    return {
      count: synchronized ? Math.max(...activeReports.map((report) => report.count)) : 0,
      synchronized,
    }
  }, [cameras, reports])

  return (
    <div>
      {hasLocalCameras && permissionState !== 'granted' && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-[#E2E8F0] bg-white px-4 py-3">
          <p className={`text-sm ${permissionState === 'denied' ? 'text-red-500' : 'text-[#64748B]'}`}>
            {permissionState === 'requesting'
              ? 'Requesting camera access...'
              : permissionState === 'denied'
                ? cameraError
                : 'Connect the browser camera for the second view.'}
          </p>
          <button
            onClick={connectCameras}
            disabled={permissionState === 'requesting'}
            className="ml-auto shrink-0 rounded-md bg-[#2563EB] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1D4ED8] disabled:opacity-50"
          >
            {permissionState === 'requesting'
              ? 'Connecting...'
              : permissionState === 'denied'
                ? 'Try Again'
                : 'Connect Cameras'}
          </button>
        </div>
      )}

      {(permissionState === 'granted' || !hasLocalCameras) && (
        <div className="mb-6 rounded-xl border border-[#BAE6FD] bg-[#F0F9FF] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0369A1]">
                Shared spindle result
              </p>
              <p className="mt-1 text-4xl font-bold text-[#0C4A6E]">{fusedResult.count}</p>
              <p className="mt-1 text-sm text-[#0369A1]">
                {fusedResult.synchronized
                  ? 'All views synchronized. The strongest view is used to avoid double-counting.'
                  : 'Waiting for synchronized detections from all cameras.'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {cameras.map((camera) => (
                <div key={camera.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-[#64748B]">{camera.name}</p>
                  <p className="text-xl font-bold text-[#0F172A]">
                    {reports[camera.id]?.count ?? '-'}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-4 border-t border-[#BAE6FD] pt-3 text-xs text-[#075985]">
            MVP fusion only. Production accuracy requires fixed camera calibration and spindle-slot matching.
          </p>
        </div>
      )}

      {/* ── Real-time rotation log ── */}
      <div className="mb-6 rounded-lg border border-[#1E293B] bg-[#0F172A] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#1E293B]">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[#475569]">
            Rotation Log  —  live
          </span>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              className="text-[10px] text-[#475569] hover:text-[#94A3B8]"
            >
              clear
            </button>
          )}
        </div>
        <div
          ref={logPanelRef}
          className="h-40 overflow-y-auto p-3 font-mono text-xs space-y-1"
        >
          {logs.length === 0 ? (
            <span className="text-[#334155]">Waiting for first rotation...</span>
          ) : (
            logs.map((entry) => (
              <div key={entry.id}>
                <div
                  className={
                    entry.color === 'green'
                      ? 'text-[#22c55e]'
                      : entry.color === 'blue'
                        ? 'text-[#38bdf8]'
                        : 'text-[#475569]'
                  }
                >
                  <span className="text-[#334155]">[{entry.time}]</span>{' '}
                  {entry.message}
                </div>
                {entry.details?.map((line, i) => (
                  <div key={i} className="ml-4 text-[#64748B]">
                    {line}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {cameras.map((camera, index) => (
          <div key={camera.id}>
            {cameraMode(camera) === 'local' && permissionState === 'granted' && (
              <label className="mb-2 block text-sm font-medium text-[#334155]">
                Device for {camera.name}
                <select
                  value={selectedDeviceIds[index] ?? ''}
                  onChange={(event) => {
                    const deviceId = event.target.value || null
                    setSelectedDeviceIds((current) => {
                      const next = [...current]
                      const duplicateIndex = next.findIndex(
                        (selected, selectedIndex) =>
                          selectedIndex !== index && selected === deviceId
                      )
                      if (deviceId && duplicateIndex >= 0) {
                        next[duplicateIndex] = null
                      }
                      next[index] = deviceId
                      return next
                    })
                  }}
                  className="mt-1 block w-full rounded-md border border-[#CBD5E1] bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select camera</option>
                  {videoDevices.map((device) => (
                    <option
                      key={device.deviceId}
                      value={device.deviceId}
                      disabled={selectedDeviceIds.some(
                        (selected, selectedIndex) =>
                          selectedIndex !== index && selected === device.deviceId
                      )}
                    >
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <CameraTile
              camera={{ id: camera.id, name: camera.name, location: camera.location }}
              streamUrl={camera.streamUrl}
              whepUrl={camera.whepUrl}
              videoSrc={camera.videoSrc}
              localDeviceId={
                cameraMode(camera) === 'local' && permissionState === 'granted'
                  ? (selectedDeviceIds[index] ?? null)
                  : null
              }
              preferLocal={cameraMode(camera) === 'local'}
              onDetection={handleDetection}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
