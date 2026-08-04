import LocalCameraGrid from '@/components/local-camera-grid'

const CAMERAS = [
  { id: 'CAM-01', name: 'Cam-EN-T', location: 'Entry — top view' },
  { id: 'CAM-02', name: 'Cam-EN-S', location: 'Entry — side view' },
] as const

export default function CamerasPage() {
  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
        <p className="mt-1 text-[#64748B]">
          Annotated feeds from Colab via Cloudflare Realtime
        </p>
      </div>
      <LocalCameraGrid cameras={[...CAMERAS]} />
    </div>
  )
}
