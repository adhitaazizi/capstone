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
  /**
   * 'processed' only: the **source** session this annotated track was derived
   * from, as it was at subscribe time.
   *
   * Provenance, not decoration. The browser publisher mints a brand-new
   * Cloudflare session every time the operator reloads /cameras, picks a
   * different device, or another machine takes over the camera. The GPU worker
   * stays bound to whichever session it subscribed to, so its annotated track
   * keeps heartbeating as healthy while carrying no frames at all. Recording
   * where the track came from is what lets consumers tell "annotated video for
   * the stream publishing right now" from "annotated video for a publisher
   * that is long gone".
   *
   * Optional because capstone_inference.ipynb — the interchangeable Colab half
   * — predates the field. Absent means "unknown provenance", which callers
   * must not treat as a match.
   */
  sourceSessionId?: string
}

export interface SessionRegistration {
  sessionId: string
  trackName: string
  sourceSessionId?: string
}

export class SessionRegistry {
  private readonly entries = new Map<ProducerRole, Map<string, CameraSession>>()

  /** Register (or heartbeat) every camera a producer is currently publishing. */
  register(
    role: ProducerRole,
    sessions: Record<string, SessionRegistration>
  ): void {
    let byCamera = this.entries.get(role)
    if (!byCamera) {
      byCamera = new Map()
      this.entries.set(role, byCamera)
    }

    const now = Date.now()
    for (const [cameraId, entry] of Object.entries(sessions)) {
      const { sessionId, trackName, sourceSessionId } = entry
      const previous = byCamera.get(cameraId)
      if (previous && previous.sessionId !== sessionId) {
        console.info(
          `[inference] ${role}/${cameraId} session changed ` +
            `${previous.sessionId} → ${sessionId}`
        )
      }
      byCamera.set(cameraId, { sessionId, trackName, sourceSessionId, updatedAt: now })
    }
  }

  /**
   * Drop registrations for a producer.
   *
   * The browser publisher calls this on Stop and on `pagehide`, so the health
   * strip and GET /api/inference/source reflect a deliberate shutdown
   * immediately instead of waiting out the 45 s staleness window.
   */
  unregister(role: ProducerRole, cameraIds?: string[]): void {
    const byCamera = this.entries.get(role)
    if (!byCamera) return
    if (!cameraIds) {
      byCamera.clear()
      return
    }
    for (const cameraId of cameraIds) byCamera.delete(cameraId)
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

  /**
   * Processed sessions that are still worth showing: fresh, and derived from
   * the source session that is publishing *right now*.
   *
   * The second condition is the one that matters. A processed registration
   * outlives the publisher it was built from — the worker subscribes once, then
   * heartbeats its own annotated session forever, entirely unaware that the
   * browser reloaded and replaced the source session underneath it. Serving
   * that entry gives the dashboard a track that negotiates fine and decodes
   * nothing: a black tile wearing an ONLINE badge, which reads as "the camera
   * is broken" rather than "the worker is pointed at a dead session".
   *
   * Entries with no `sourceSessionId` (capstone_inference.ipynb, which predates
   * it) can only be freshness-checked — there is nothing to match against.
   */
  liveProcessed(now = Date.now()): Record<string, CameraSession> {
    const byCamera = this.entries.get('processed')
    if (!byCamera) return {}

    const live: Record<string, CameraSession> = {}
    for (const [cameraId, entry] of byCamera.entries()) {
      if (now - entry.updatedAt >= REGISTRATION_STALE_MS) continue

      if (entry.sourceSessionId !== undefined) {
        const source = this.entries.get('source')?.get(cameraId)
        if (!source) continue
        if (source.sessionId !== entry.sourceSessionId) continue
        if (now - source.updatedAt >= REGISTRATION_STALE_MS) continue
      }

      live[cameraId] = entry
    }
    return live
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
