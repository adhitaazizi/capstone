import LocalCameraGrid from '@/components/local-camera-grid'

const CAMERAS = [
  { id: 'CAM-01', name: 'Cam-EN-T', location: 'Entry — top view', sourceMode: 'stream', streamPath: 'spindle_cam_3' },
  { id: 'CAM-02', name: 'Cam-EN-S', location: 'Entry — side view', sourceMode: 'stream', streamPath: 'spindle_cam_4' },
  { id: 'CAM-03', name: 'Cam-EX-T', location: 'Exit — top view', sourceMode: 'stream', streamPath: 'spindle_cam_1' },
  { id: 'CAM-04', name: 'Cam-EX-S', location: 'Exit — side view', sourceMode: 'stream', streamPath: 'spindle_cam_2' },
] as const

export default function CamerasPage() {

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
        <p className="mt-1 text-[#64748B]">
          Live feeds from entry and exit checkpoints
        </p>
      </div>
      <LocalCameraGrid
        cameras={CAMERAS.map((camera) => ({
          ...camera,
          streamUrl: `/api/stream/${camera.id}`,
        }))}
      />
    </div>
  )
}
