/**
 * The page's side of the ss helper — a small native app the host runs that
 * embeds a torrent engine and serves the bytes over localhost HTTP with CORS.
 *
 * It replaces the whole browser-can't-do-this problem: the helper reaches the
 * TCP/uTP swarm natively, knows exactly which bytes are ready, and serves them
 * with Range requests, so `read(start, end)` is a plain ranged fetch that blocks
 * on the helper until those bytes have downloaded. No CORS games (the helper
 * sets the headers), no File System Access, no client to configure.
 */

import { isSubtitleFileName } from './subtitleFormats'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile } from './torrent'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
// A fixed loopback port the helper binds. Uncommon, to avoid clashing with the
// usual dev servers.
export const HELPER_ORIGIN = 'http://127.0.0.1:32227'
const HEALTH_TIMEOUT_MS = 600
const AVAILABILITY_TTL_MS = 4_000

interface HelperFile {
  index: number
  name: string
  path: string
  size: number
}

interface AddResponse {
  id: string
  name: string
  files: HelperFile[]
}

let availabilityCheckedAt = 0
let availableCache = false
let helperVersionValue = ''

/** The running helper's version, or '' when it is not reachable. */
export function helperVersion(): string {
  return helperVersionValue
}

async function withTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Forgets the cached availability, so the next check probes again. For tests. */
export function resetHelperAvailability(): void {
  availabilityCheckedAt = 0
  availableCache = false
}

/** True when the ss helper is running and answering, cached briefly. */
export async function helperAvailable(): Promise<boolean> {
  const now = Date.now()
  if (now - availabilityCheckedAt < AVAILABILITY_TTL_MS && availabilityCheckedAt !== 0) return availableCache
  availabilityCheckedAt = now
  try {
    const response = await withTimeout(`${HELPER_ORIGIN}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS)
    // Confirm it is actually our helper, not some other server on the port.
    const body = response.ok ? await response.json() as { name?: string; version?: string } : null
    availableCache = body?.name === 'ss-bridge'
    helperVersionValue = availableCache ? (body?.version ?? '') : ''
  } catch {
    availableCache = false
    helperVersionValue = ''
  }
  return availableCache
}

async function helperJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${HELPER_ORIGIN}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`helper ${path} failed (${response.status})`)
  return await response.json() as T
}

/**
 * Opens a magnet in the helper and returns a session shaped exactly like the
 * bridge/WebTorrent ones, so the upload path drives it unchanged. Reads are
 * ranged fetches the helper answers once the bytes are downloaded — the room
 * plays while the torrent is still coming down.
 */
export async function openHelperTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
): Promise<TorrentSession> {
  const added = await helperJson<AddResponse>('/add', { method: 'POST', body: JSON.stringify({ magnet }) })
  let selectedIndex = -1
  let destroyed = false

  const streamRange = async (index: number, start: number, endInclusive: number): Promise<ArrayBuffer> => {
    if (destroyed) throw new Error('torrent session closed')
    const response = await fetch(`${HELPER_ORIGIN}/stream/${encodeURIComponent(added.id)}/${index}`, {
      headers: { Range: `bytes=${start}-${endInclusive}` },
    })
    if (!response.ok && response.status !== 206) throw new Error(`helper stream failed (${response.status})`)
    const data = await response.arrayBuffer()
    const expected = endInclusive - start + 1
    if (data.byteLength !== expected) throw new Error(`helper short read (${data.byteLength}/${expected})`)
    return data
  }

  const files = added.files
    .filter((file) => VIDEO_EXTENSION.test(file.name))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      index: file.index,
      size: file.size,
      type: 'application/octet-stream',
      // Progress is read off the session poll, not per file; the room only ever
      // plays the one selected file.
      get progress() { return 0 },
      get downloaded() { return 0 },
      read: (start, endInclusive) => streamRange(file.index, start, endInclusive),
    }))
    .sort((a, b) => b.size - a.size)

  const subtitleFiles = added.files
    .filter((file) => isSubtitleFileName(file.name) && file.size > 0 && file.size <= MAX_SIDE_FILE_BYTES)
    .map((file): TorrentSideFile => ({
      name: file.name,
      path: file.path,
      size: file.size,
      read: () => streamRange(file.index, 0, file.size - 1),
    }))

  let currentStats: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }
  const refreshStats = async () => {
    try {
      const stats = await helperJson<TorrentStats>(`/stats/${encodeURIComponent(added.id)}`, { method: 'GET' })
      currentStats = stats
      onStats?.(stats)
    } catch { /* stats are best effort */ }
  }
  onStats?.(currentStats)
  const statsTimer = window.setInterval(() => { void refreshStats() }, 1_000)

  return {
    name: added.name,
    files,
    subtitleFiles,
    stats: () => currentStats,
    select: async (path) => {
      const file = files.find((candidate) => candidate.path === path)
      if (!file) throw new Error('torrent file not found')
      selectedIndex = file.index
      // Focus the swarm on this one file, in order, so its start arrives first.
      await helperJson(`/select`, { method: 'POST', body: JSON.stringify({ id: added.id, fileIndex: selectedIndex }) })
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.clearInterval(statsTimer)
      // Best effort: let the helper forget the torrent this tab opened.
      void fetch(`${HELPER_ORIGIN}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: added.id }),
        keepalive: true,
      }).catch(() => undefined)
    },
  }
}
