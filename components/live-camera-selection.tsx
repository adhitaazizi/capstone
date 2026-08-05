'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Power, RefreshCw, VideoOff } from 'lucide-react'
import Button from '@/components/ui/button'
import { useSession } from '@/hooks/use-session'

interface LocalCamera { deviceId: string; label: string }
interface CameraSelection { entry: string; exit: string; entryEnabled: boolean; exitEnabled: boolean }

const STORAGE_KEY = 'spraycount.live-camera-selection'
const EMPTY_SELECTION: CameraSelection = { entry: '', exit: '', entryEnabled: false, exitEnabled: false }

function readSelection(): CameraSelection {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<CameraSelection>
    return { entry: parsed.entry ?? '', exit: parsed.exit ?? '', entryEnabled: parsed.entryEnabled ?? false, exitEnabled: parsed.exitEnabled ?? false }
  } catch { return EMPTY_SELECTION }
}

function CameraBox({ title, selectedId, otherSelectedId, enabled, cameras, isAdmin, videoRef, onSelect, onToggle }: {
  title: string; selectedId: string; otherSelectedId: string; enabled: boolean; cameras: LocalCamera[]; isAdmin: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>; onSelect: (id: string) => void; onToggle: () => void
}) {
  return <section className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
    <div className="flex items-center justify-between border-b border-[#E2E8F0] px-5 py-4">
      <div><h2 className="text-lg font-semibold text-[#1E293B]">{title}</h2><p className="text-sm text-[#64748B]">One camera per checkpoint</p></div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${enabled ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>{enabled ? 'ON' : 'OFF'}</span>
    </div>
    <div className="relative aspect-video bg-[#1E293B]"><video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />{!enabled && <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-center text-white"><VideoOff className="mb-2 h-8 w-8" /><p className="text-sm">Camera is OFF</p></div>}</div>
    <div className="space-y-3 p-5">
      <label className="block text-sm font-medium text-[#334155]">Select laptop camera
        <select className="mt-2 w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#0EA5E9] disabled:bg-[#F8FAFC]" value={selectedId} disabled={!isAdmin || cameras.length === 0} onChange={(event) => onSelect(event.target.value)}>
          <option value="">No camera selected</option>{cameras.filter((camera) => camera.deviceId === selectedId || camera.deviceId !== otherSelectedId).map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
        </select>
      </label>
      {isAdmin && <Button className="w-full" size="sm" variant={enabled ? 'danger' : 'success'} disabled={!selectedId} onClick={onToggle}><Power className="mr-2 h-4 w-4" />{enabled ? 'Turn camera OFF' : 'Turn camera ON'}</Button>}
    </div>
  </section>
}

export default function LiveCameraSelection() {
  const { isLoading: authLoading, isAdmin } = useSession()
  const [cameras, setCameras] = useState<LocalCamera[]>([])
  const [selection, setSelection] = useState<CameraSelection>(EMPTY_SELECTION)
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entryVideoRef = useRef<HTMLVideoElement>(null)
  const exitVideoRef = useRef<HTMLVideoElement>(null)

  const saveSelection = (next: CameraSelection) => { setSelection(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) }

  const detectCameras = useCallback(async () => {
    setDetecting(true); setError(null)
    try {
      if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser does not support local camera detection.')
      const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach((track) => track.stop())
      const next = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Laptop camera ${index + 1}` }))
      setCameras(next)
      setSelection((current) => { const available = new Set(next.map((camera) => camera.deviceId)); const entry = available.has(current.entry) ? current.entry : ''; const exit = available.has(current.exit) && current.exit !== entry ? current.exit : ''; const nextSelection = { ...current, entry, exit, entryEnabled: entry ? current.entryEnabled : false, exitEnabled: exit ? current.exitEnabled : false }; localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSelection)); return nextSelection })
      if (next.length === 0) setError('No camera is connected to this laptop.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to detect laptop cameras.'); setCameras([]) }
    finally { setDetecting(false); setLoading(false) }
  }, [])

  useEffect(() => { setSelection(readSelection()); if (!authLoading) void detectCameras() }, [authLoading, detectCameras])

  useEffect(() => {
    const streams: MediaStream[] = []
    const connect = async (deviceId: string, video: HTMLVideoElement | null, enabled: boolean) => { if (!deviceId || !enabled || !video) return; try { const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } }); streams.push(stream); video.srcObject = stream } catch { setError('Unable to open the selected laptop camera.') } }
    void connect(selection.entry, entryVideoRef.current, selection.entryEnabled); void connect(selection.exit, exitVideoRef.current, selection.exitEnabled)
    return () => { streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop())); if (entryVideoRef.current) entryVideoRef.current.srcObject = null; if (exitVideoRef.current) exitVideoRef.current.srcObject = null }
  }, [selection.entry, selection.exit, selection.entryEnabled, selection.exitEnabled])

  const selectCamera = (checkpoint: 'entry' | 'exit', deviceId: string) => saveSelection({ ...selection, [checkpoint]: deviceId, [`${checkpoint}Enabled`]: deviceId ? selection[`${checkpoint}Enabled`] : false } as CameraSelection)
  const toggleCamera = (checkpoint: 'entry' | 'exit') => { if (selection[checkpoint]) saveSelection({ ...selection, [`${checkpoint}Enabled`]: !selection[`${checkpoint}Enabled`] } as CameraSelection) }

  if (loading || authLoading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" /></div>
  return <div>
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1><p className="mt-1 text-[#64748B]">Select one laptop camera for each checkpoint</p></div>{isAdmin && <Button variant="secondary" loading={detecting} onClick={() => void detectCameras()}><RefreshCw className="mr-2 h-4 w-4" />Detect cameras</Button>}</div>
    {error && <div className="mb-5 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">{error}</div>}
    {cameras.length > 0 ? <div className="grid grid-cols-1 gap-6 md:grid-cols-2"><CameraBox title="Entry Camera" selectedId={selection.entry} otherSelectedId={selection.exit} enabled={selection.entryEnabled} cameras={cameras} isAdmin={isAdmin} videoRef={entryVideoRef} onSelect={(id) => selectCamera('entry', id)} onToggle={() => toggleCamera('entry')} /><CameraBox title="Exit Camera" selectedId={selection.exit} otherSelectedId={selection.entry} enabled={selection.exitEnabled} cameras={cameras} isAdmin={isAdmin} videoRef={exitVideoRef} onSelect={(id) => selectCamera('exit', id)} onToggle={() => toggleCamera('exit')} /></div> : <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-[#E2E8F0] bg-white p-6 text-center"><div><VideoOff className="mx-auto h-8 w-8 text-[#94A3B8]" /><p className="mt-3 text-[#64748B]">No laptop camera detected</p></div></div>}
  </div>
}
