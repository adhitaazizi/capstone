import LocalCameraGrid from '@/components/local-camera-grid'

const CAMERAS = [
  { id: 'CAM-01', name: 'Cam-EN-T', location: 'Checkpoint A — Entry Top' },
  { id: 'CAM-02', name: 'Cam-EN-S', location: 'Checkpoint A — Entry Side' },
]

export default function CamerasPage() {
  const rawHost = process.env.ESP32_HOST || 'localhost:8080'
  const baseUrl = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`
  const inputMode = process.env.CAMERA_INPUT_MODE === 'stream' ? 'stream' : 'local'

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
        <p className="mt-1 text-[#64748B]">
          Two synchronized views of one spindle before the spray machine
        </p>
      </div>
      <LocalCameraGrid
        cameras={CAMERAS.map((camera) => ({
          ...camera,
          streamUrl: inputMode === 'stream'
            ? `/api/stream/${camera.id}`
            : `${baseUrl}/stream/${camera.id}`,
        }))}
        inputMode={inputMode}
      />
    </div>
  )
}
