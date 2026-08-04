/**
 * Cloudflare Realtime session registry.
 *
 * Two producers register here so nothing has to be pasted by hand:
 *   - the edge worker registers **source** sessions (raw camera tracks),
 *     which Colab reads via GET /api/inference/source;
 *   - Colab registers **processed** sessions (annotated tracks), which the
 *     dashboard reads via GET /api/inference/live.
 *
 * Both re-register on a 15 s heartbeat, so a missing heartbeat is how we know a
 * producer has died rather than merely gone quiet.
 *
 * Registration is per camera, not one shared session for every camera. Each
 * camera gets an independent Cloudflare Realtime session — bundling multiple
 * tracks onto one shared connection does not work against Cloudflare's SFU
 * (confirmed directly: two tracks on one connection never completed ICE,
 * while the identical code with a single track connected immediately). See
 * services/edge/main.py's CameraPublisher docstring for the full explanation.
 */

export type ProducerRole = 'source' | 'processed'

/** Two missed 15 s heartbeats. */
export const REGISTRATION_STALE_MS = 45_000

export interface CameraSession {
  sessionId: string
  trackName: string
  updatedAt: number
}

export class SessionRegistry {
  private readonly entries = new Map<ProducerRole, Map<string, CameraSession>>()

  /** Register (or heartbeat) every camera a producer is currently publishing. */
  register(
    role: ProducerRole,
    sessions: Record<string, { sessionId: string; trackName: string }>
  ): void {
    let byCamera = this.entries.get(role)
    if (!byCamera) {
      byCamera = new Map()
      this.entries.set(role, byCamera)
    }

    const now = Date.now()
    for (const [cameraId, { sessionId, trackName }] of Object.entries(sessions)) {
      const previous = byCamera.get(cameraId)
      if (previous && previous.sessionId !== sessionId) {
        console.info(
          `[inference] ${role}/${cameraId} session changed ` +
            `${previous.sessionId} → ${sessionId}`
        )
      }
      byCamera.set(cameraId, { sessionId, trackName, updatedAt: now })
    }
  }

  get(role: ProducerRole, cameraId: string): CameraSession | null {
    return this.entries.get(role)?.get(cameraId) ?? null
  }

  getAll(role: ProducerRole): Record<string, CameraSession> {
    const byCamera = this.entries.get(role)
    if (!byCamera) return {}
    return Object.fromEntries(byCamera.entries())
  }

  isFresh(role: ProducerRole, cameraId: string, now = Date.now()): boolean {
    const entry = this.entries.get(role)?.get(cameraId)
    return entry !== undefined && now - entry.updatedAt < REGISTRATION_STALE_MS
  }

  /** True once at least one camera of this role is registered and fresh. */
  hasFreshAny(role: ProducerRole, now = Date.now()): boolean {
    const byCamera = this.entries.get(role)
    if (!byCamera) return false
    for (const entry of byCamera.values()) {
      if (now - entry.updatedAt < REGISTRATION_STALE_MS) return true
    }
    return false
  }
}
