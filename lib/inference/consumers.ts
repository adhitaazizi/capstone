/**
 * Annotated-stream consumer registry.
 *
 * Counting is gated on the annotated video actually being consumed: until a
 * browser on /cameras is decoding the annotated track for a camera, that
 * camera's detections are dropped and no visit, pairing, or `spindle_pass` row
 * is produced for it.
 *
 * The reason is that "the GPU worker is POSTing detections" is a much weaker
 * statement than it looks. The worker subscribes to a source session once and
 * then keeps inferring and heartbeating forever — across a browser reload, a
 * device swap, or another machine taking over the camera — so detections keep
 * arriving that describe a stream nobody can see and that may no longer
 * correspond to anything the line is doing. Frames decoding in a viewer is the
 * one signal that is end-to-end: it means the publisher, Cloudflare, the
 * worker, and the annotated track are all alive *at the same time*.
 *
 * A heartbeat therefore records **which processed session** the viewer is
 * decoding, not merely that some viewer exists. lib/inference/pipeline.ts's
 * gate matches it against the processed session currently registered for the
 * camera, so a viewer still nursing a track from a replaced worker cannot hold
 * the gate open for detections coming from a different one.
 */

/**
 * Five missed beats.
 *
 * components/camera-tile.tsx heartbeats from its 2 s frame watchdog, and only
 * when framesDecoded has advanced — so the heartbeat stops on its own the
 * moment the picture freezes, and this window is how long counting survives
 * that. Deliberately far shorter than REGISTRATION_STALE_MS (45 s): a producer
 * going quiet is normal and worth tolerating, whereas a viewer that stopped
 * seeing frames is precisely the condition this gate exists to catch.
 */
export const CONSUMER_STALE_MS = 10_000

export interface ConsumerEntry {
  /** The processed (annotated) Cloudflare session whose frames are decoding. */
  sessionId: string
  updatedAt: number
}

export class ConsumerRegistry {
  private readonly viewers = new Map<string, ConsumerEntry>()

  /** Record that a viewer decoded a frame of `sessionId` for `cameraId`. */
  heartbeat(cameraId: string, sessionId: string, now = Date.now()): void {
    if (!this.viewers.has(cameraId)) {
      console.info(`[inference] ${cameraId} annotated stream is being consumed`)
    }
    this.viewers.set(cameraId, { sessionId, updatedAt: now })
  }

  /**
   * Drop consumer entries.
   *
   * Called on tile teardown so closing /cameras pauses counting immediately
   * rather than after CONSUMER_STALE_MS.
   */
  release(cameraIds?: string[]): void {
    if (!cameraIds) {
      this.viewers.clear()
      return
    }
    for (const cameraId of cameraIds) this.viewers.delete(cameraId)
  }

  /** The fresh entry for a camera, or null if there is none. */
  get(cameraId: string, now = Date.now()): ConsumerEntry | null {
    const entry = this.viewers.get(cameraId)
    if (!entry) return null
    if (now - entry.updatedAt >= CONSUMER_STALE_MS) {
      // Reaped on read rather than on a timer: this process has no other clock,
      // and every reader goes through here.
      this.viewers.delete(cameraId)
      console.info(
        `[inference] ${cameraId} annotated stream is no longer being consumed`
      )
      return null
    }
    return entry
  }

  /** Camera ids whose annotated stream is being consumed right now. */
  active(now = Date.now()): string[] {
    const ids: string[] = []
    for (const cameraId of [...this.viewers.keys()]) {
      if (this.get(cameraId, now)) ids.push(cameraId)
    }
    return ids
  }
}
