/**
 * A room the desktop app produces on the host's machine (`kind: "local"`).
 * The app writes the source into its cache as regions; the host's player
 * reads them from there. Nothing reaches the bucket until the server says a
 * browser guest needs it (`needBrowserMedia`): then the room is promoted
 * and the app uploads from the cache, playhead first, until the last
 * browser guest leaves (`browserMediaIdle`).
 */
import { useSyncExternalStore } from 'react'
import { desktop } from '../platform'
import { registerRemuxHandle, unregisterRemuxHandle } from '../upload'
import type { MediaRegion } from '../types'

export type LocalSource =
  | { kind: 'torrent'; id: string; index: number; title: string }
  | { kind: 'youtube'; url: string; videoId: string; title: string }

export interface LocalMedia {
  /** The cache entry's base: the player reads `<root>/hls/<name>`. */
  root: string
  generation: number
  regions: MediaRegion[]
}

export interface ControllerAuth {
  memberId: string
  capability: string
}

interface Meta {
  key: string
  title: string
  durationMs: number
}

interface Attached {
  key: string
  media: LocalMedia
  positionMs: number
  poll: ReturnType<typeof setInterval>
}

const POLL_MS = 1000
const rooms = new Map<string, Attached>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Prepares the source in the app's cache and makes this tab the room's
 * local producer. Resolves null when it took, or with why it did not.
 */
export async function attachLocalRoom(roomId: string, generation: number, source: LocalSource): Promise<string | null> {
  const app = await desktop()
  if (!app) return 'desktop app unavailable'
  let meta: Meta
  try {
    meta = await app.invoke<Meta>('local_prepare', { source })
  } catch (error) {
    return `local prepare failed: ${reason(error)}`
  }
  detach(roomId)
  const attached: Attached = {
    key: meta.key,
    media: { root: `${app.mediaRoot}/${meta.key}`, generation, regions: [] },
    positionMs: 0,
    poll: setInterval(() => { void refreshLocalMedia(roomId) }, POLL_MS),
  }
  rooms.set(roomId, attached)
  const handle = {
    follow: (absoluteMs: number) => {
      attached.positionMs = Math.max(0, Math.round(absoluteMs))
      void app.invoke('local_follow', { key: attached.key, positionMs: attached.positionMs }).catch(() => undefined)
    },
  }
  registerRemuxHandle(roomId, handle, () => {
    unregisterRemuxHandle(roomId, handle)
    if (rooms.get(roomId) !== attached) return
    detach(roomId)
    void app.invoke('upload_stop', { roomId }).catch(() => undefined)
    void app.invoke('local_stop', { key: attached.key }).catch(() => undefined)
  })
  emit()
  void refreshLocalMedia(roomId)
  return null
}

function detach(roomId: string): void {
  const attached = rooms.get(roomId)
  if (!attached) return
  clearInterval(attached.poll)
  rooms.delete(roomId)
  emit()
}

/** The cache this tab plays the room from; null when the room is not local here. */
export function localMediaFor(roomId: string): LocalMedia | null {
  return rooms.get(roomId)?.media ?? null
}

export async function refreshLocalMedia(roomId: string): Promise<void> {
  const attached = rooms.get(roomId)
  const app = await desktop()
  if (!attached || !app) return
  try {
    const regions = await app.invoke<MediaRegion[]>('local_regions', { key: attached.key })
    if (rooms.get(roomId) !== attached) return
    if (JSON.stringify(regions) === JSON.stringify(attached.media.regions)) return
    attached.media = { ...attached.media, regions }
    emit()
  } catch {}
}

/** A browser guest needs the room: promote it and upload from the cache. */
export async function needBrowserMedia(roomId: string, auth: ControllerAuth): Promise<void> {
  const attached = rooms.get(roomId)
  if (!attached) return
  const app = await desktop()
  if (!app) return
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/local/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: auth.memberId, capability: auth.capability }),
    })
    if (!response.ok) {
      console.warn('local promote refused', response.status)
      return
    }
    const claim = await response.json() as { claim: string; mediaGeneration: number }
    await app.invoke('upload_start', {
      key: attached.key,
      roomId,
      claim: claim.claim,
      mediaGeneration: claim.mediaGeneration,
      positionMs: attached.positionMs,
    })
  } catch (error) {
    console.warn('local upload did not start', error)
  }
}

/** The last browser guest left: what is in the bucket stays, nothing more goes up. */
export async function browserMediaIdle(roomId: string): Promise<void> {
  if (!rooms.has(roomId)) return
  const app = await desktop()
  await app?.invoke('upload_stop', { roomId }).catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useLocalRoomMedia(roomId: string): LocalMedia | null {
  return useSyncExternalStore(subscribe, () => localMediaFor(roomId), () => null)
}

export function resetLocalRoomsForTests(): void {
  for (const roomId of [...rooms.keys()]) detach(roomId)
}
