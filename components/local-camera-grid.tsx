'use client'

import { useCallback, useMemo, useState } from 'react'

import CameraTile from '@/components/camera-tile'

interface CameraConfig {
  id: string
  name: string
  location: string
  streamUrl: string
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

type PermissionState = 'idle' | 'requesting' | 'granted' | 'denied'

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
    (cameraId: string, count: number, confidenceAvg: number) => {
      setReports((current) => ({
        ...current,
        [cameraId]: { count, confidenceAvg, timestamp: Date.now() },
      }))
    },
    []
  )

  const fusedResult = useMemo(() => {
    const activeReports = cameras
      .map((camera) => reports[camera.id])
      .filter((report): report is DetectionReport => Boolean(report))

    if (activeReports.length !== cameras.length) {
      return { count: 0, synchronized: false }
    }

    const timestamps = activeReports.map((report) => report.timestamp)
    const synchronized = Math.max(...timestamps) - Math.min(...timestamps) <= 1500

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
                  ? 'Two views synchronized. The strongest view is used to avoid double-counting.'
                  : 'Waiting for synchronized detections from both cameras.'}
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
