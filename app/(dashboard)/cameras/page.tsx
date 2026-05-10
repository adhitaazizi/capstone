import { createServerClient } from '@/lib/supabase/server'
import CameraTile from '@/components/camera-tile'

export const dynamic = 'force-dynamic'

interface Camera {
  camera_id: number
  camera_code: string
  name: string
  location: string
}

export default async function CamerasPage() {
  const supabase = createServerClient()

  const { data: cameras } = await supabase
    .from('camera')
    .select('camera_id, camera_code, name, location')
    .order('camera_id', { ascending: true })

  const rawHost = process.env.ESP32_HOST || '192.168.1.100'
  const baseUrl = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Live Cameras</h1>
        <p className="mt-1 text-[#64748B]">
          Real-time video streams from production line cameras
        </p>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {cameras?.map((camera: Camera) => (
          <CameraTile
            key={camera.camera_id}
            camera={{
              id: camera.camera_code,
              name: camera.name,
              location: camera.location,
            }}
            streamUrl={`${baseUrl}/stream/${camera.camera_code}`}
          />
        ))}
      </div>
      {(!cameras || cameras.length === 0) && (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-[#E2E8F0] bg-white">
          <p className="text-[#64748B]">No cameras configured</p>
        </div>
      )}
    </div>
  )
}
