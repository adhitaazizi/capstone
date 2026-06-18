import LocalCameraGrid from '@/components/local-camera-grid'

const CAMERAS = [
  { id: 'CAM-01', name: 'Cam-EN-T', location: 'Blender RTSP view', sourceMode: 'stream' },
  { id: 'CAM-02', name: 'Cam-EN-S', location: 'Browser camera view', sourceMode: 'local' },
] as const

export default function CamerasPage() {
  const rawHost = process.env.ESP32_HOST || 'localhost:8080'
  const baseUrl = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
        <p className="mt-1 text-[#64748B]">
          One Blender RTSP view and one browser camera view for the same spindle
        </p>
      </div>
      <LocalCameraGrid
        cameras={CAMERAS.map((camera) => ({
          ...camera,
          streamUrl:
            camera.sourceMode === 'stream'
              ? `/api/stream/${camera.id}`
              : `${baseUrl}/stream/${camera.id}`,
        }))}
      />
    </div>
  )
}
