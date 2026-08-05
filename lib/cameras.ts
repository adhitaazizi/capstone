/**
 * The canonical camera list.
 *
 * Single source of truth for three consumers that must agree exactly:
 *   - the `/cameras` page, which renders a tile per camera;
 *   - the browser publisher (`lib/webrtc/publisher.ts`), which publishes one
 *     Cloudflare track per camera;
 *   - `app/api/cameras/register/route.ts`, which refuses to register a camera
 *     id that is not in this list.
 *
 * `id` must match ENTRY_CAMERA_ID / EXIT_CAMERA_ID in lib/inference/constants.ts
 * — the FIFO pairing in lib/inference/queue.ts assumes a spindle reaches the
 * entry camera before the exit camera, and keys both sides on these ids.
 *
 * `trackName` is the Cloudflare Realtime track name. It is derived here rather
 * than accepted from a client so that the uniqueness invariant enforced by
 * services/inference/discovery.py's normalize_cameras() cannot be violated.
 */

export interface CameraConfig {
  id: string
  name: string
  location: string
  trackName: string
}

export const CAMERAS: readonly CameraConfig[] = [
  {
    id: 'CAM-01',
    name: 'Entry',
    location: 'Upstream — before the spray station',
    trackName: 'cam-01',
  },
  {
    id: 'CAM-02',
    name: 'Exit',
    location: 'Downstream — after the spray station',
    trackName: 'cam-02',
  },
] as const

export const CAMERA_IDS: readonly string[] = CAMERAS.map((camera) => camera.id)

export function isKnownCameraId(cameraId: string): boolean {
  return CAMERAS.some((camera) => camera.id === cameraId)
}

/** The Cloudflare track name for a camera, or null when the id is unknown. */
export function trackNameFor(cameraId: string): string | null {
  return CAMERAS.find((camera) => camera.id === cameraId)?.trackName ?? null
}
