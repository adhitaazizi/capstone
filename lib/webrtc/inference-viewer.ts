'use client'

import { signal, waitForIceGathering } from './signal'

export type InferenceViewerStatus = 'connecting' | 'online' | 'offline'

export interface InferenceViewerSnapshot {
  status: InferenceViewerStatus
  stream: MediaStream | null
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const FRAME_POLL_MS = 2_000
const STALLED_POLLS_BEFORE_RECONNECT = 3

class InferenceViewer {
  private listeners = new Set<() => void>()
  private snapshot: InferenceViewerSnapshot = { status: 'offline', stream: null }
  private targetKey: string | null = null
  private pc: RTCPeerConnection | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private frameTimer: ReturnType<typeof setInterval> | null = null
  private attempt = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): InferenceViewerSnapshot => this.snapshot

  ensure(sessionId: string, trackName: string): void {
    const targetKey = `${sessionId}:${trackName}`
    if (this.targetKey === targetKey && (this.pc || this.retryTimer)) return

    this.targetKey = targetKey
    this.attempt = 0
    this.teardown()
    this.setSnapshot({ status: 'connecting', stream: null })
    void this.connect(sessionId, trackName, targetKey)
  }

  private setSnapshot(snapshot: InferenceViewerSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private stopFrameWatchdog(): void {
    if (!this.frameTimer) return
    clearInterval(this.frameTimer)
    this.frameTimer = null
  }

  private teardown(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.stopFrameWatchdog()
    if (this.pc) {
      this.pc.ontrack = null
      this.pc.onconnectionstatechange = null
      for (const receiver of this.pc.getReceivers()) receiver.track?.stop()
      this.pc.close()
      this.pc = null
    }
  }

  private scheduleReconnect(sessionId: string, trackName: string, targetKey: string): void {
    if (this.targetKey !== targetKey || this.retryTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt)
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.targetKey !== targetKey) return
      this.teardown()
      this.setSnapshot({ status: 'connecting', stream: null })
      void this.connect(sessionId, trackName, targetKey)
    }, delay)
  }

  private startFrameWatchdog(
    conn: RTCPeerConnection,
    sessionId: string,
    trackName: string,
    targetKey: string
  ): void {
    this.stopFrameWatchdog()
    let lastDecoded = -1
    let stalledPolls = 0

    this.frameTimer = setInterval(async () => {
      if (this.pc !== conn || this.targetKey !== targetKey) return
      let decoded = 0
      try {
        const stats = await conn.getStats()
        stats.forEach((report) => {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video') return
          const framesDecoded = (report as { framesDecoded?: number }).framesDecoded
          if (typeof framesDecoded === 'number') decoded = Math.max(decoded, framesDecoded)
        })
      } catch {
        return
      }
      if (this.pc !== conn || this.targetKey !== targetKey) return

      if (decoded > lastDecoded) {
        lastDecoded = decoded
        stalledPolls = 0
        if (decoded > 0) {
          this.attempt = 0
          this.setSnapshot({ status: 'online', stream: this.snapshot.stream })
        }
        return
      }

      stalledPolls += 1
      if (stalledPolls >= STALLED_POLLS_BEFORE_RECONNECT) {
        this.setSnapshot({ status: 'offline', stream: null })
        this.teardown()
        this.scheduleReconnect(sessionId, trackName, targetKey)
      }
    }, FRAME_POLL_MS)
  }

  private async connect(sessionId: string, trackName: string, targetKey: string): Promise<void> {
    const conn = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      bundlePolicy: 'max-bundle',
    })
    this.pc = conn

    conn.ontrack = (event) => {
      if (this.pc !== conn || this.targetKey !== targetKey) return
      this.setSnapshot({ status: 'connecting', stream: new MediaStream([event.track]) })
      this.startFrameWatchdog(conn, sessionId, trackName, targetKey)
    }

    conn.onconnectionstatechange = () => {
      if (this.pc !== conn || this.targetKey !== targetKey) return
      if (conn.connectionState === 'connected') {
        this.attempt = 0
      } else if (
        conn.connectionState === 'failed' ||
        conn.connectionState === 'disconnected' ||
        conn.connectionState === 'closed'
      ) {
        this.setSnapshot({ status: 'offline', stream: null })
        this.teardown()
        this.scheduleReconnect(sessionId, trackName, targetKey)
      }
    }

    try {
      conn.addTransceiver('video', { direction: 'recvonly' })
      await conn.setLocalDescription(await conn.createOffer())
      await waitForIceGathering(conn)
      if (this.pc !== conn || this.targetKey !== targetKey) return

      const sessionData = await signal('/sessions/new', {
        sessionDescription: {
          type: conn.localDescription!.type,
          sdp: conn.localDescription!.sdp,
        },
      })
      if (this.pc !== conn || this.targetKey !== targetKey) return
      const viewerSessionId: string = sessionData.sessionId
      await conn.setRemoteDescription(new RTCSessionDescription(sessionData.sessionDescription))

      const tracksData = await signal(`/sessions/${viewerSessionId}/tracks/new`, {
        tracks: [{ location: 'remote', sessionId, trackName }],
      })
      if (this.pc !== conn || this.targetKey !== targetKey) return

      if (tracksData.requiresImmediateRenegotiation) {
        await conn.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
        await conn.setLocalDescription(await conn.createAnswer())
        await waitForIceGathering(conn)
        if (this.pc !== conn || this.targetKey !== targetKey) return
        await signal(
          `/sessions/${viewerSessionId}/renegotiate`,
          {
            sessionDescription: {
              type: conn.localDescription!.type,
              sdp: conn.localDescription!.sdp,
            },
          },
          'PUT'
        )
      } else if (tracksData.sessionDescription) {
        await conn.setRemoteDescription(new RTCSessionDescription(tracksData.sessionDescription))
      }
    } catch (error) {
      if (this.pc !== conn || this.targetKey !== targetKey) return
      console.error('[inference viewer] Cloudflare WebRTC failed:', error)
      this.setSnapshot({ status: 'offline', stream: null })
      this.teardown()
      this.scheduleReconnect(sessionId, trackName, targetKey)
    }
  }
}

const GLOBAL_KEY = Symbol.for('spraycount.inference.viewer-registry')

type ViewerRegistry = Map<string, InferenceViewer>

function registry(): ViewerRegistry {
  const store = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ViewerRegistry }
  if (!store[GLOBAL_KEY]) store[GLOBAL_KEY] = new Map()
  return store[GLOBAL_KEY]
}

export function inferenceViewer(cameraId: string): InferenceViewer {
  const viewers = registry()
  let viewer = viewers.get(cameraId)
  if (!viewer) {
    viewer = new InferenceViewer()
    viewers.set(cameraId, viewer)
  }
  return viewer
}
