'use client'

import { useEffect, useSyncExternalStore } from 'react'

import {
  IDLE_SNAPSHOT,
  publisher,
  type PublisherSnapshot,
} from '@/lib/webrtc/publisher'

/**
 * Bind the camera publisher's state into React.
 *
 * The publisher itself is a plain singleton, not React state: PeerConnections
 * and MediaStreams must not be torn down by StrictMode's double effect
 * invocation, and publishing should survive navigating away from /cameras.
 * This hook only reads from it.
 *
 * Note what the effect deliberately does NOT do: it never calls stop(). Adding
 * that would look like correct cleanup and would silently kill the camera feed
 * every time the component remounts.
 */
export function usePublisher(): PublisherSnapshot {
  const snapshot = useSyncExternalStore(
    publisher().subscribe,
    publisher().getSnapshot,
    () => IDLE_SNAPSHOT
  )

  useEffect(() => {
    // Idempotent — safe under StrictMode's double invocation.
    publisher().init()
  }, [])

  return snapshot
}

/** Imperative controls, kept separate so the snapshot stays a plain value. */
export function publisherActions() {
  const controller = publisher()
  return {
    requestPermission: () => controller.requestPermission(),
    refreshDevices: () => controller.refreshDevices(),
    selectDevice: (cameraId: string, deviceId: string) =>
      controller.selectDevice(cameraId, deviceId),
    duplicateSelection: () => controller.duplicateSelection(),
    start: () => controller.start(),
    stop: () => controller.stop(),
    startOne: (cameraId: string) => controller.startOne(cameraId),
    stopOne: (cameraId: string) => controller.stopOne(cameraId),
    retry: (cameraId: string) => controller.retry(cameraId),
  }
}
