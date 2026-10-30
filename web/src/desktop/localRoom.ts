/**
 * A room the desktop app produces on the host's machine (`kind: "local"`).
 * The app writes the source into its cache as regions; the host's player
 * reads them from there. A guest on the app opens the same torrent or video
 * from the room's `localCopy` and plays a cache of its own the same way.
 * Nothing reaches the bucket until the server says someone needs it
 * (`needBrowserMedia`): a browser, or an app whose own copy failed. Then the
 * room is promoted and the app uploads from the cache, playhead first, until
 * the last of them leaves (`browserMediaIdle`).
 */
import { useSyncExternalStore } from 'react'
import { desktop } from '../platform'
import { registerRemuxHandle, unregisterRemuxHandle } from '../upload'
import type { LocalCopy, MediaRegion } from '../types'

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
  low: boolean
  lastFollow: number
  /** The position last handed to the app. */
  sentMs: number | null
  followTimer: ReturnType<typeof setTimeout> | null
  /** Set while a guest waits on the bucket: who to promote as, again if the upload dies. */
  wanted: ControllerAuth | null
  uploadWatch: ReturnType<typeof setInterval> | null
}

const POLL_MS = 1000
/** How often the upload is checked, and so how soon a dead one is promoted again. */
const UPLOAD_WATCH_MS = 5_000
/** A seek burst reaches the app as one follow now and its last one later. */
const FOLLOW_DEBOUNCE_MS = 3_000
/**
 * Play, pause and the gate opening name the place the app already has; they
 * go nowhere, so the seek after them is not held back as part of a burst.
 */
const SAME_PLACE_MS = 2_000
const rooms = new Map<string, Attached>()
/** The follow of a room this tab plays its own copy of, as a guest. */
const copies = new Map<string, (absoluteMs: number) => void>()
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
  return await attach(roomId, generation, source, true)
}

/**
 * Opens the source another member shared in this app and plays it from a
 * cache of its own. Resolves null when it took, or with why it did not; the
 * caller then plays the bucket and tells the room so.
 */
export async function openLocalCopy(roomId: string, generation: number, copy: LocalCopy, title: string): Promise<string | null> {
  const app = await desktop()
  if (!app) return 'desktop app unavailable'
  let source: LocalSource
  if (copy.kind === 'torrent') {
    try {
      const torrent = await app.invoke<{ id: string }>('torrent_open', { magnet: copy.magnet })
      await app.invoke('torrent_select', { id: torrent.id, index: copy.index })
      source = { kind: 'torrent', id: torrent.id, index: copy.index, title }
    } catch (error) {
      return `torrent open failed: ${reason(error)}`
    }
  } else {
    source = { kind: 'youtube', url: copy.url, videoId: copy.videoId, title }
  }
  return await attach(roomId, generation, source, false)
}

/** The room moved on from the copy this tab played: its production stops, the cache stays. */
export function closeLocalCopy(roomId: string, generation: number): void {
  const attached = rooms.get(roomId)
  if (!attached || !copies.has(roomId) || attached.media.generation !== generation) return
  detach(roomId)
  void desktop().then((app) => app?.invoke('local_stop', { key: attached.key })).catch(() => undefined)
}

/** Where the room is now, for the copy this tab plays as a guest. */
export function followLocalCopy(roomId: string, absoluteMs: number): void {
  copies.get(roomId)?.(absoluteMs)
}

async function attach(roomId: string, generation: number, source: LocalSource, produce: boolean): Promise<string | null> {
  const app = await desktop()
  if (!app) return 'desktop app unavailable'
  let meta: Meta
  try {
    meta = await app.invoke<Meta>('local_prepare', { source })
  } catch (error) {
    return `local prepare failed: ${reason(error)}`
  }
  const copied = copies.has(roomId) ? rooms.get(roomId) : undefined
  if (copied && copied.key !== meta.key) void app.invoke('local_stop', { key: copied.key }).catch(() => undefined)
  detach(roomId)
  const attached: Attached = {
    key: meta.key,
    media: { root: `${app.mediaRoot}/${meta.key}`, generation, regions: [] },
    positionMs: 0,
    poll: setInterval(() => { void refreshLocalMedia(roomId) }, POLL_MS),
    low: false,
    lastFollow: -Infinity,
    sentMs: null,
    followTimer: null,
    wanted: null,
    uploadWatch: null,
  }
  rooms.set(roomId, attached)
  const send = () => {
    attached.lastFollow = Date.now()
    attached.sentMs = attached.positionMs
    void app.invoke('local_follow', { key: attached.key, positionMs: attached.positionMs }).catch(() => undefined)
  }
  const handle = {
    follow: (absoluteMs: number) => {
      attached.positionMs = Math.max(0, Math.round(absoluteMs))
      if (attached.followTimer !== null) return
      if (attached.sentMs !== null && Math.abs(attached.positionMs - attached.sentMs) < SAME_PLACE_MS) return
      const since = Date.now() - attached.lastFollow
      if (since >= FOLLOW_DEBOUNCE_MS) {
        send()
        return
      }
      attached.followTimer = setTimeout(() => {
        attached.followTimer = null
        if (rooms.get(roomId) === attached) send()
      }, FOLLOW_DEBOUNCE_MS - since)
    },
  }
  if (!produce) {
    copies.set(roomId, handle.follow)
    emit()
    void refreshLocalMedia(roomId)
    return null
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
  if (attached.followTimer !== null) clearTimeout(attached.followTimer)
  stopWatching(attached)
  rooms.delete(roomId)
  copies.delete(roomId)
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

function stopWatching(attached: Attached): void {
  attached.wanted = null
  if (attached.uploadWatch !== null) clearInterval(attached.uploadWatch)
  attached.uploadWatch = null
}

/**
 * A guest needs the room: promote it and upload from the cache. While the
 * guest waits, an upload that stops on its own (a lost claim, a network
 * that gave up) is promoted again.
 */
export async function needBrowserMedia(roomId: string, auth: ControllerAuth): Promise<void> {
  const attached = rooms.get(roomId)
  if (!attached || copies.has(roomId)) return
  attached.wanted = auth
  if (attached.uploadWatch === null) {
    attached.uploadWatch = setInterval(() => { void reviveUpload(roomId) }, UPLOAD_WATCH_MS)
  }
  await promote(roomId, attached, auth)
}

async function reviveUpload(roomId: string): Promise<void> {
  const attached = rooms.get(roomId)
  const app = await desktop()
  if (!attached?.wanted || !app) return
  const status = await app.invoke<{ active: boolean; error: string | null }>('upload_status', { roomId }).catch(() => null)
  // Stopped without an error is an upload that finished the film.
  if (!status || status.active || !status.error || rooms.get(roomId) !== attached || !attached.wanted) return
  console.warn('local upload stopped, promoting again', status.error)
  await promote(roomId, attached, attached.wanted)
}

async function promote(roomId: string, attached: Attached, auth: ControllerAuth): Promise<void> {
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

/**
 * The room's renditions (`renditions` in the room JSON): with `480p`, the
 * app encodes the low variant by hardware from the playhead on.
 */
export async function setLocalRenditions(roomId: string, renditions: string[] | undefined): Promise<void> {
  const attached = rooms.get(roomId)
  if (!attached) return
  const on = renditions?.includes('480p') ?? false
  if (on === attached.low) return
  attached.low = on
  const app = await desktop()
  await app?.invoke('local_low', { key: attached.key, on, positionMs: attached.positionMs }).catch(() => undefined)
}

/** The last guest left: what is in the bucket stays, nothing more goes up. */
export async function browserMediaIdle(roomId: string): Promise<void> {
  const attached = rooms.get(roomId)
  if (!attached) return
  stopWatching(attached)
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
