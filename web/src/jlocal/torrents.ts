import { getCachedJLocalCapabilities, refreshJLocalCapabilities } from './capabilities'
import { JLOCAL_ORIGIN, getJLocalSnapshot } from './status'

// Talking to the companion app's local torrent engine. Every fetch here is
// loopback-exempt like the /health probe, and every payload parses strictly:
// anything off-shape is null, never a throw, so the native browser flows
// keep working untouched.

export interface JLocalTorrentAdded {
  /** Infohash hex. */
  id: string
  name: string
}

export interface JLocalTorrentFile {
  index: number
  path: string
  size: number
  /** Last path segment, for display. */
  name: string
}

/** What the picker hands to the room flow once a file is chosen. */
export interface JLocalPickedStream {
  url: string
  name: string
  size: number
  torrentId: string
  torrentName: string
}

const INFOHASH_HEX = /^[0-9a-fA-F]{40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** POST /torrent/add answers exactly {id, name}; a room-JSON-shaped body parses to null. */
export function parseJLocalTorrentAdded(body: unknown): JLocalTorrentAdded | null {
  if (!isRecord(body)) return null
  const { id, name } = body
  if (typeof id !== 'string' || !INFOHASH_HEX.test(id)) return null
  if (typeof name !== 'string' || name.length === 0) return null
  return { id, name }
}

/**
 * Registers a magnet with the app. Never throws: anything off-shape,
 * non-200, or unreachable is null, and the caller falls back to the
 * native flow.
 */
export async function addMagnet(signal: AbortSignal, magnet: string): Promise<JLocalTorrentAdded | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/torrent/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet }),
      signal,
    })
    if (!response.ok) return null
    return parseJLocalTorrentAdded(await response.json())
  } catch {
    return null
  }
}

function parseTorrentFiles(body: unknown, id: string): JLocalTorrentFile[] | null {
  if (!isRecord(body)) return null
  const { torrents } = body
  if (!Array.isArray(torrents)) return null
  for (const entry of torrents) {
    if (!isRecord(entry) || entry.id !== id || !Array.isArray(entry.files)) continue
    const files: JLocalTorrentFile[] = []
    for (const file of entry.files) {
      if (!isRecord(file)) return null
      const { index, path, size } = file
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
      if (typeof path !== 'string' || path.length === 0) return null
      if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null
      const name = path.split('/').pop() ?? path
      files.push({ index, path, size, name })
    }
    return files
  }
  return null
}

/** Lists the added torrent's files. Never throws; null means use the native flow. */
export async function listJLocalTorrentFiles(signal: AbortSignal, id: string): Promise<JLocalTorrentFile[] | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/torrent/list`, { signal })
    if (!response.ok) return null
    return parseTorrentFiles(await response.json(), id)
  } catch {
    return null
  }
}

/** Pins the file the app serves bytes for. Never throws. */
export async function selectJLocalFile(signal: AbortSignal, id: string, file: number): Promise<boolean> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/torrent/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, file }),
      signal,
    })
    return response.ok
  } catch {
    return false
  }
}

/** Ranged-bytes URL the remux Range path reads through. Accepts an index or a path. */
export function torrentStreamUrl(id: string, file: number | string): string {
  return `${JLOCAL_ORIGIN}/torrent/data/${encodeURIComponent(id)}/${encodeURIComponent(String(file))}`
}

/**
 * Sync gate for the local-torrent path. Pure read, no fetch, no await, same
 * no-await shape as isJLocalCaptureAvailable: when connected but uncached it
 * kicks off a background refresh and still answers false for this click.
 *
 * Note: the cache timestamp lives inside capabilities.ts, so staleness here
 * is gate-on-cache-only — a stale true resolves on the next advertisement
 * refresh, and a stale false self-heals the same way.
 */
export function isJLocalTorrentAvailable(): boolean {
  const snapshot = getJLocalSnapshot()
  if (!snapshot.connected) return false
  const cached = getCachedJLocalCapabilities()
  if (cached === null) {
    refreshJLocalCapabilities()
    return false
  }
  return cached.torrent.available === true
}
