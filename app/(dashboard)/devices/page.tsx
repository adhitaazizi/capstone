'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, Edit, MapPin, Monitor, HardDrive } from 'lucide-react'

import Badge from '@/components/ui/badge'
import Button from '@/components/ui/button'
import Input from '@/components/ui/input'
import Modal from '@/components/ui/modal'
import { useSession } from '@/hooks/use-session'
import { useRealtime } from '@/hooks/use-realtime'

interface CameraDevice {
  camera_id: number
  camera_code: string
  name: string
  location: string | null
  position_type: 'entry' | 'exit'
  status: 'active' | 'inactive' | 'error'
  resolution: string | null
  created_at: string
}

function StatusBadge({ status }: { status: CameraDevice['status'] }) {
  const variant =
    status === 'active'
      ? 'success'
      : status === 'error'
        ? 'danger'
        : 'warning'

  return <Badge variant={variant}>{status}</Badge>
}

export default function DevicesPage() {
  const { user, isLoading: authLoading, isAdmin } = useSession()
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [editCamera, setEditCamera] = useState<CameraDevice | null>(null)
  const [editForm, setEditForm] = useState({
    name: '',
    location: '',
    resolution: '',
  })
  const [editLoading, setEditLoading] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const { data: realtimeCameras } = useRealtime<CameraDevice>('camera')

  const fetchCameras = useCallback(async () => {
    try {
      const res = await fetch('/api/devices')
      const json = await res.json()
      if (res.ok && json.data) {
        setCameras(json.data)
      }
    } catch {
      setCameras([])
    }
  }, [])

  useEffect(() => {
    fetchCameras().finally(() => setLoading(false))
  }, [fetchCameras])

  useEffect(() => {
    if (realtimeCameras.length > 0) {
      setCameras((current) => {
        const map = new Map(current.map((c) => [c.camera_id, c]))
        for (const item of realtimeCameras) {
          map.set(item.camera_id, item)
        }
        return Array.from(map.values()).sort(
          (a, b) => a.camera_id - b.camera_id
        )
      })
    }
  }, [realtimeCameras])

  const handleEditOpen = (camera: CameraDevice) => {
    setEditCamera(camera)
    setEditForm({
      name: camera.name,
      location: camera.location ?? '',
      resolution: camera.resolution ?? '',
    })
    setEditError(null)
  }

  const handleEditClose = () => {
    setEditCamera(null)
    setEditError(null)
  }

  const handleEditSubmit = async () => {
    if (!editCamera) return
    setEditLoading(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/devices/${editCamera.camera_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name,
          location: editForm.location || null,
          resolution: editForm.resolution || null,
        }),
      })
      const json = await res.json()
      if (res.ok) {
        setCameras((current) =>
          current.map((c) =>
            c.camera_id === editCamera.camera_id ? json.data : c
          )
        )
        handleEditClose()
      } else {
        setEditError(json.error || 'Failed to update device')
      }
    } catch {
      setEditError('Network error')
    } finally {
      setEditLoading(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Device Management</h1>
        <p className="mt-1 text-[#64748B]">
          View and manage camera devices on the production line
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {cameras.map((camera) => (
          <div
            key={camera.camera_id}
            className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#0EA5E9]/10">
                  <Camera className="h-5 w-5 text-[#0EA5E9]" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[#1E293B]">
                    {camera.name}
                  </h3>
                  <span className="text-xs text-[#94A3B8]">
                    {camera.camera_code}
                  </span>
                </div>
              </div>
              {isAdmin && (
                <button
                  onClick={() => handleEditOpen(camera)}
                  className="rounded-lg p-1.5 text-[#94A3B8] transition-colors hover:bg-[#F1F5F9] hover:text-[#0EA5E9]"
                  aria-label="Edit device"
                >
                  <Edit className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-[#64748B]">
                <MapPin className="h-4 w-4 shrink-0" />
                <span>{camera.location || '—'}</span>
              </div>
              <div className="flex items-center gap-2 text-[#64748B]">
                <HardDrive className="h-4 w-4 shrink-0" />
                <span className="capitalize">{camera.position_type}</span>
              </div>
              <div className="flex items-center gap-2 text-[#64748B]">
                <Monitor className="h-4 w-4 shrink-0" />
                <span>{camera.resolution || '—'}</span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <StatusBadge status={camera.status} />
              <span className="text-xs text-[#94A3B8]">
                {new Date(camera.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {cameras.length === 0 && (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-[#E2E8F0] bg-white">
          <p className="text-[#64748B]">No devices configured</p>
        </div>
      )}

      <Modal
        open={!!editCamera}
        onClose={handleEditClose}
        title="Edit Device"
        actions={
          <>
            <Button variant="secondary" onClick={handleEditClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={editLoading}
              onClick={handleEditSubmit}
            >
              Save Changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={editForm.name}
            onChange={(e) =>
              setEditForm((prev) => ({ ...prev, name: e.target.value }))
            }
          />
          <Input
            label="Location"
            value={editForm.location}
            onChange={(e) =>
              setEditForm((prev) => ({ ...prev, location: e.target.value }))
            }
          />
          <Input
            label="Resolution"
            value={editForm.resolution}
            onChange={(e) =>
              setEditForm((prev) => ({ ...prev, resolution: e.target.value }))
            }
          />
          {editError && (
            <p className="text-sm text-[#EF4444]">{editError}</p>
          )}
        </div>
      </Modal>
    </div>
  )
}
