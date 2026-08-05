/**
 * Browser camera publisher.
 *
 * Captures the machine's webcams and publishes one VP8 track per camera to
 * Cloudflare Realtime, then heartbeats the resulting sessions to Next.js so the
 * GPU inference worker can discover them. This replaces the Python edge worker
 * that used to do the same job from RTSP or video files.
 *
 * Two structural decisions are load-bearing:
 *
 * 1. **The lifecycle lives outside React.** Publishing starts on an explicit
 *    click and stops on an explicit Stop, on pagehide, or when a track ends —
 *    never from an effect cleanup. React StrictMode double-invokes effects in
 *    development, so a PeerConnection owned by an effect would be torn down and
 *    rebuilt on every hot reload, orphaning Cloudflare sessions each time. The
 *    happy side effect is that navigating away from /cameras does not drop the
 *    stream the GPU worker is subscribed to.
 *
 * 2. **One PeerConnection and one Cloudflare session per camera.** A camera can
 *    then fail, retry, or swap devices without disturbing the other. A shared
 *    session would also be accepted downstream — normalize_cameras in
 *    services/inference/discovery.py requires unique track names, not unique
 *    session ids — so collapsing to a single connection stays available if
 *    Cloudflare ever misbehaves with two.
 */

import { CAMERAS, type CameraConfig } from '@/lib/cameras'
import { getIceServers } from '@/lib/webrtc/ice'
import { setLocalAndGather, signal } from '@/lib/webrtc/signal'
import { assertVp8Only, preferVp8 } from '@/lib/webrtc/vp8'

// Registration goes stale server-side after 45 s (REGISTRATION_STALE_MS).
// 10 s gives four missed beats of margin rather than two.
const HEARTBEAT_MS = 10_000
const CONNECT_TIMEOUT_MS = 60_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const DEVICE_STORAGE_KEY = 'spraycount.publisher.devices'

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  // The server samples on a 2 s interval and the model runs at 640x640, so
  // 15 fps is generous and halves the uplink versus 30.
  frameRate: { ideal: 15, max: 30 },
}

const FALLBACK_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 15, max: 30 },
}

export type CameraPhase = 'idle' | 'starting' | 'live' | 'error'

export interface CameraPublishState {
  cameraId: string
  name: string
  location: string
  trackName: string
  deviceId: string | null
  deviceLabel: string | null
  phase: CameraPhase
  error: string | null
  sessionId: string | null
  stream: MediaStream | null
  iceState: RTCIceConnectionState | null
}

export interface PublisherSnapshot {
  supported: boolean
  secureContext: boolean
  origin: string
  permission: 'unknown' | 'granted' | 'denied'
  devices: { deviceId: string; label: string }[]
  cameras: CameraPublishState[]
  publishing: boolean
  lastHeartbeatAt: number | null
  registerError: string | null
  takeoverWarning: string | null
}

function idleCameraState(camera: CameraConfig): CameraPublishState {
  return {
    cameraId: camera.id,
    name: camera.name,
    location: camera.location,
    trackName: camera.trackName,
    deviceId: null,
    deviceLabel: null,
    phase: 'idle',
    error: null,
    sessionId: null,
    stream: null,
    iceState: null,
  }
}

/** Frozen so useSyncExternalStore's server snapshot is referentially stable. */
export const IDLE_SNAPSHOT: PublisherSnapshot = Object.freeze({
  supported: false,
  secureContext: false,
  origin: '',
  permission: 'unknown' as const,
  devices: [],
  cameras: CAMERAS.map(idleCameraState),
  publishing: false,
  lastHeartbeatAt: null,
  registerError: null,
  takeoverWarning: null,
})

/** Turn a getUserMedia failure into something an operator can act on. */
function describeMediaError(error: unknown): string {
  const name = (error as DOMException)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Click the camera icon in the address bar, allow access, then Retry.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'That camera is no longer connected. Pick a different one.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is in use by another application (Zoom, OBS, Teams). Close it and Retry.'
    case 'OverconstrainedError':
      return 'This camera does not support the requested resolution.'
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

/** Resolve once the PeerConnection is usable, or reject with why it is not. */
function waitForConnected(
  pc: RTCPeerConnection,
  cameraId: string
): Promise<void> {
  const isUp = () =>
    pc.connectionState === 'connected' ||
    pc.iceConnectionState === 'connected' ||
    pc.iceConnectionState === 'completed'

  if (isUp()) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      pc.removeEventListener('connectionstatechange', onChange)
      pc.removeEventListener('iceconnectionstatechange', onChange)
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }

    function onChange() {
      if (isUp()) {
        finish()
      } else if (
        pc.connectionState === 'failed' ||
        pc.iceConnectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        finish(
          new Error(
            `[${cameraId}] connection failed (ICE ${pc.iceConnectionState}). ` +
              'If this persists, the network may need a TURN relay — set ' +
              'CF_TURN_KEY_ID and CF_TURN_KEY_TOKEN.'
          )
        )
      }
    }

    pc.addEventListener('connectionstatechange', onChange)
    pc.addEventListener('iceconnectionstatechange', onChange)
    const timer = setTimeout(
      () => finish(new Error(`[${cameraId}] connection timed out.`)),
      CONNECT_TIMEOUT_MS
    )
  })
}

/**
 * Publishes exactly one camera: capture, negotiate, keep it up.
 *
 * Owns its own reconnect loop so one camera dropping never disturbs the other.
 */
class CameraPublisher {
  readonly camera: CameraConfig

  phase: CameraPhase = 'idle'
  error: string | null = null

  private stream: MediaStream | null = null
  private pc: RTCPeerConnection | null = null
  private sessionId: string | null = null
  private disposed = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    camera: CameraConfig,
    private readonly onChange: () => void,
    private readonly onSessionChange: () => void
  ) {
    this.camera = camera
  }

  get currentSessionId(): string | null {
    return this.sessionId
  }
  get currentStream(): MediaStream | null {
    return this.stream
  }
  get iceState(): RTCIceConnectionState | null {
    return this.pc?.iceConnectionState ?? null
  }

  async start(deviceId: string): Promise<void> {
    this.disposed = false
    this.attempt = 0
    await this.connect(deviceId)
  }

  private async openStream(deviceId: string): Promise<MediaStream> {
    const base = { deviceId: { exact: deviceId } }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...base, ...VIDEO_CONSTRAINTS },
        audio: false,
      })
    } catch (error) {
      // A webcam that cannot do 720p should still work at 480p rather than
      // present the operator with a dead tile.
      if ((error as DOMException)?.name !== 'OverconstrainedError') throw error
      return navigator.mediaDevices.getUserMedia({
        video: { ...base, ...FALLBACK_CONSTRAINTS },
        audio: false,
      })
    }
  }

  private async connect(deviceId: string): Promise<void> {
    this.phase = 'starting'
    this.error = null
    this.onChange()

    let stream: MediaStream
    try {
      stream = this.stream ?? (await this.openStream(deviceId))
    } catch (error) {
      this.fail(describeMediaError(error))
      return
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    this.onChange()

    const track = stream.getVideoTracks()[0]
    if (!track) {
      this.fail('The camera returned no video track.')
      return
    }
    // Under bandwidth pressure, drop frames rather than resolution: the model
    // needs to resolve small toys, and the sampler only needs one good frame
    // per 2 s window.
    track.contentHint = 'detail'

    // A device unplugged mid-run ends the track; without this the tile would
    // sit at 'live' forever while publishing nothing.
    track.onended = () => {
      if (this.disposed) return
      this.fail('The camera was disconnected.')
    }

    try {
      const iceServers = await getIceServers()
      if (this.disposed) return

      const pc = new RTCPeerConnection({ iceServers })
      this.pc = pc

      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
      preferVp8(transceiver)

      const offer = await pc.createOffer()
      assertVp8Only(offer.sdp ?? '')
      const localOffer = await setLocalAndGather(pc, offer)
      if (this.disposed || this.pc !== pc) return

      const session = await signal('/sessions/new', {
        sessionDescription: { type: 'offer', sdp: localOffer.sdp },
      })
      if (this.disposed || this.pc !== pc) return

      const sessionId: string = session.sessionId
      await pc.setRemoteDescription(
        new RTCSessionDescription(session.sessionDescription)
      )
      if (this.disposed || this.pc !== pc) return

      // No mid is assigned until setLocalDescription has run; Cloudflare
      // rejects a track registration without one as a JSON validation error.
      const mid = transceiver.mid
      if (mid === null) {
        throw new Error('Cloudflare assigned no media MID for this track.')
      }

      // A fresh offer accompanies tracks/new. This matches the sequence in
      // services/inference/pipeline.py; registering the track before the
      // connection is up is what avoids Cloudflare's "Session is not ready
      // yet". If that error ever appears, wait for connection first instead.
      const registrationOffer = await pc.createOffer()
      const localRegistration = await setLocalAndGather(pc, registrationOffer)
      if (this.disposed || this.pc !== pc) return

      const tracks = await signal(`/sessions/${sessionId}/tracks/new`, {
        tracks: [{ location: 'local', mid, trackName: this.camera.trackName }],
        sessionDescription: { type: 'offer', sdp: localRegistration.sdp },
      })
      if (this.disposed || this.pc !== pc) return

      if (tracks.sessionDescription) {
        await pc.setRemoteDescription(
          new RTCSessionDescription(tracks.sessionDescription)
        )
      }
      if (this.disposed || this.pc !== pc) return

      await waitForConnected(pc, this.camera.id)
      if (this.disposed || this.pc !== pc) return

      pc.oniceconnectionstatechange = () => {
        if (this.disposed || this.pc !== pc) return
        const state = pc.iceConnectionState
        this.onChange()
        if (state === 'failed' || state === 'disconnected') {
          this.scheduleReconnect(deviceId)
        }
      }

      this.sessionId = sessionId
      this.attempt = 0
      this.phase = 'live'
      this.error = null
      this.onChange()
      // Register immediately rather than waiting up to a full heartbeat, so
      // the GPU worker can be started the moment the tile turns green.
      this.onSessionChange()
    } catch (error) {
      if (this.disposed) return
      this.error = error instanceof Error ? error.message : String(error)
      this.phase = 'error'
      this.onChange()
      this.scheduleReconnect(deviceId)
    }
  }

  private fail(message: string): void {
    this.error = message
    this.phase = 'error'
    this.teardownConnection()
    this.stopStream()
    this.onChange()
  }

  private scheduleReconnect(deviceId: string): void {
    if (this.disposed || this.retryTimer) return
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.attempt
    )
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed) return
      this.teardownConnection()
      void this.connect(deviceId)
    }, delay)
  }

  private teardownConnection(): void {
    if (!this.pc) return
    this.pc.oniceconnectionstatechange = null
    this.pc.close()
    this.pc = null
    this.sessionId = null
  }

  private stopStream(): void {
    if (!this.stream) return
    // Stopping the tracks is what turns the camera's LED off. Operators use
    // that to confirm the system really released the device.
    for (const track of this.stream.getTracks()) {
      track.onended = null
      track.stop()
    }
    this.stream = null
  }

  stop(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.teardownConnection()
    this.stopStream()
    this.phase = 'idle'
    this.error = null
    this.onChange()
  }
}

interface StoredDevice {
  deviceId: string
  label: string
}

/**
 * Owns device discovery, the per-camera publishers, and the registration
 * heartbeat. One instance per browser tab, pinned to globalThis.
 */
class PublisherController {
  private initialized = false
  private listeners = new Set<() => void>()
  private snapshot: PublisherSnapshot = IDLE_SNAPSHOT

  private devices: { deviceId: string; label: string }[] = []
  private selections = new Map<string, StoredDevice>()
  private publishers = new Map<string, CameraPublisher>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private publishing = false
  private permission: 'unknown' | 'granted' | 'denied' = 'unknown'
  private lastHeartbeatAt: number | null = null
  private registerError: string | null = null
  private takeoverWarning: string | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PublisherSnapshot => this.snapshot

  /**
   * Idempotent, so React StrictMode's double effect invocation is harmless.
   * Note this never starts publishing — that requires a click.
   */
  init(): void {
    if (this.initialized || typeof window === 'undefined') return
    this.initialized = true

    this.loadSelections()

    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      void this.refreshDevices()
    })

    // Timers in a hidden tab get throttled; re-registering on the way back
    // closes the window where the server would think the publisher died.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.publishing) {
        void this.register()
      }
    })

    // pagehide rather than beforeunload: beforeunload disqualifies the page
    // from the back/forward cache and is unreliable on mobile Safari.
    // keepalive lets the request outlive the document.
    window.addEventListener('pagehide', () => {
      if (!this.publishing) return
      void fetch('/api/cameras/register', {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {})
    })

    void this.refreshDevices()
    this.emit()
  }

  private emit(): void {
    const secureContext =
      typeof window !== 'undefined' && window.isSecureContext === true
    const supported =
      secureContext &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof RTCPeerConnection !== 'undefined'

    this.snapshot = {
      supported,
      secureContext,
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      permission: this.permission,
      devices: this.devices,
      cameras: CAMERAS.map((camera) => {
        const publisher = this.publishers.get(camera.id)
        const selection = this.selections.get(camera.id)
        return {
          cameraId: camera.id,
          name: camera.name,
          location: camera.location,
          trackName: camera.trackName,
          deviceId: selection?.deviceId ?? null,
          deviceLabel: selection?.label ?? null,
          phase: publisher?.phase ?? 'idle',
          error: publisher?.error ?? null,
          sessionId: publisher?.currentSessionId ?? null,
          stream: publisher?.currentStream ?? null,
          iceState: publisher?.iceState ?? null,
        }
      }),
      publishing: this.publishing,
      lastHeartbeatAt: this.lastHeartbeatAt,
      registerError: this.registerError,
      takeoverWarning: this.takeoverWarning,
    }
    for (const listener of this.listeners) listener()
  }

  // --- devices -------------------------------------------------------------

  private loadSelections(): void {
    try {
      const raw = window.localStorage.getItem(DEVICE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, StoredDevice>
      for (const [cameraId, value] of Object.entries(parsed)) {
        if (value?.deviceId) this.selections.set(cameraId, value)
      }
    } catch {
      // Corrupt or unavailable storage is not worth failing over.
    }
  }

  private saveSelections(): void {
    try {
      window.localStorage.setItem(
        DEVICE_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(this.selections))
      )
    } catch {
      // Safari private mode throws on setItem.
    }
  }

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.emit()
      return
    }

    const all = await navigator.mediaDevices.enumerateDevices()
    this.devices = all
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }))

    // Empty labels mean permission has not been granted yet — the picker would
    // show meaningless placeholders, so the UI asks for access instead.
    const labelled = all.some(
      (device) => device.kind === 'videoinput' && device.label !== ''
    )
    if (this.permission === 'unknown' && labelled) {
      this.permission = 'granted'
    }

    this.reconcileSelections()
    this.emit()
  }

  /**
   * Re-resolve stored selections against the devices actually present.
   *
   * deviceId is only stable while the camera permission persists — it rotates
   * on revocation and is per-session in incognito — so the label is the
   * fallback key.
   */
  private reconcileSelections(): void {
    for (const [cameraId, stored] of this.selections) {
      const byId = this.devices.find((d) => d.deviceId === stored.deviceId)
      if (byId) continue
      const byLabel = this.devices.find((d) => d.label === stored.label)
      if (byLabel) {
        this.selections.set(cameraId, byLabel)
      } else {
        this.selections.delete(cameraId)
      }
    }
    this.saveSelections()
  }

  async requestPermission(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      // Immediately released: this call exists only to unlock device labels.
      stream.getTracks().forEach((track) => track.stop())
      this.permission = 'granted'
      this.registerError = null
    } catch (error) {
      this.permission = 'denied'
      this.registerError = describeMediaError(error)
    }
    await this.refreshDevices()
  }

  selectDevice(cameraId: string, deviceId: string): void {
    const device = this.devices.find((d) => d.deviceId === deviceId)
    if (!device) return
    this.selections.set(cameraId, device)
    this.saveSelections()
    this.emit()
  }

  /** Two cameras on one device would make the entry/exit comparison vacuous. */
  duplicateSelection(): boolean {
    const ids = [...this.selections.values()].map((s) => s.deviceId)
    return new Set(ids).size !== ids.length
  }

  // --- publishing ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.publishing) return
    this.registerError = null
    this.takeoverWarning = null
    this.publishing = true
    this.emit()

    for (const camera of CAMERAS) {
      const selection = this.selections.get(camera.id)
      if (!selection) continue
      const cameraPublisher = new CameraPublisher(
        camera,
        () => this.emit(),
        () => void this.register()
      )
      this.publishers.set(camera.id, cameraPublisher)
      // Sequential rather than parallel: two simultaneous getUserMedia calls
      // on some USB hubs make the second fail with NotReadableError.
      await cameraPublisher.start(selection.deviceId)
    }

    await this.register()
    this.heartbeat = setInterval(() => void this.register(), HEARTBEAT_MS)
    this.emit()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const cameraPublisher of this.publishers.values()) cameraPublisher.stop()
    this.publishers.clear()
    this.publishing = false
    this.lastHeartbeatAt = null
    this.emit()

    try {
      await fetch('/api/cameras/register', { method: 'DELETE' })
    } catch {
      // The registration ages out after 45 s regardless.
    }
  }

  /** Start publishing exactly one camera, independent of the others — the
   *  checkpoint toggles in components/live-camera-selection.tsx need this;
   *  start()/stop() above are all-or-nothing. */
  async startOne(cameraId: string): Promise<void> {
    const camera = CAMERAS.find((c) => c.id === cameraId)
    const selection = this.selections.get(cameraId)
    if (!camera || !selection) return

    this.publishers.get(cameraId)?.stop()
    this.registerError = null
    this.publishing = true
    this.emit()

    const cameraPublisher = new CameraPublisher(
      camera,
      () => this.emit(),
      () => void this.register()
    )
    this.publishers.set(cameraId, cameraPublisher)
    await cameraPublisher.start(selection.deviceId)
    await this.register()
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => void this.register(), HEARTBEAT_MS)
    }
    this.emit()
  }

  async stopOne(cameraId: string): Promise<void> {
    this.publishers.get(cameraId)?.stop()
    this.publishers.delete(cameraId)
    this.emit()

    try {
      await fetch('/api/cameras/register', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cameraIds: [cameraId] }),
      })
    } catch {
      // The registration ages out after 45 s regardless.
    }

    if (this.publishers.size === 0) {
      if (this.heartbeat) {
        clearInterval(this.heartbeat)
        this.heartbeat = null
      }
      this.publishing = false
      this.lastHeartbeatAt = null
    }
    this.emit()
  }

  async retry(cameraId: string): Promise<void> {
    const camera = CAMERAS.find((c) => c.id === cameraId)
    const selection = this.selections.get(cameraId)
    if (!camera || !selection) return

    this.publishers.get(cameraId)?.stop()
    const cameraPublisher = new CameraPublisher(
      camera,
      () => this.emit(),
      () => void this.register()
    )
    this.publishers.set(cameraId, cameraPublisher)
    await cameraPublisher.start(selection.deviceId)
    await this.register()
  }

  /** Push every live session to the registry the GPU worker reads. */
  private async register(): Promise<void> {
    const sessions: Record<string, { sessionId: string; trackName: string }> = {}
    for (const cameraPublisher of this.publishers.values()) {
      const sessionId = cameraPublisher.currentSessionId
      if (sessionId) {
        sessions[cameraPublisher.camera.id] = {
          sessionId,
          trackName: cameraPublisher.camera.trackName,
        }
      }
    }
    if (Object.keys(sessions).length === 0) return

    try {
      const resp = await fetch('/api/cameras/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions }),
      })
      if (
        resp.redirected ||
        !resp.headers.get('content-type')?.includes('application/json')
      ) {
        throw new Error(
          'Your session expired. Reload the page and sign in again.'
        )
      }
      const data = await resp.json()
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`)

      this.lastHeartbeatAt = Date.now()
      this.registerError = null
      this.takeoverWarning =
        Array.isArray(data.replaced) && data.replaced.length > 0
          ? `Took over ${data.replaced.join(', ')} from another browser that was publishing it.`
          : null
    } catch (error) {
      this.registerError = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }
}

// Symbol.for survives module re-evaluation under Fast Refresh, which would
// otherwise orphan the running PeerConnections behind a fresh controller.
// Mirrors the pinning in lib/inference/pipeline.ts.
const GLOBAL_KEY = Symbol.for('spraycount.camera.publisher')

export function publisher(): PublisherController {
  const store = globalThis as unknown as Record<
    symbol,
    PublisherController | undefined
  >
  if (!store[GLOBAL_KEY]) store[GLOBAL_KEY] = new PublisherController()
  return store[GLOBAL_KEY]!
}
