/**
 * The companion app as a torrent backend: the swarm runs on the host's own
 * machine and the app remuxes the picked file itself, the way a worker does,
 * publishing into the room's bucket (see ./production). Nothing about the
 * fleet is touched, so no worker is measured or placed.
 */
import { JLOCAL_ORIGIN, getJLocalSnapshot } from './status'
import { fetchJLocalCapabilities } from './capabilities'
import { startJlocalProduction, withTimeout } from './production'
import { isSubtitleFileName } from '../subtitleFormats'
import { TorrentRejectedError, orderVideoFiles, parseMagnet } from '../remoteTorrent'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile } from '../torrent'

const CAPABILITIES_TIMEOUT_MS = 1500
const ADD_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 10_000
const STATS_MS = 2_000
const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024

/** The app refused before anything started; the fleet may still take the magnet. */
export class JlocalTorrentError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'JlocalTorrentError'
  }
}

/** Whether the app is here with a live swarm and the FFmpeg to prepare a file. */
export async function jlocalTorrentUsable(): Promise<boolean> {
  if (!getJLocalSnapshot().connected) return false
  const caps = await fetchJLocalCapabilities(withTimeout(CAPABILITIES_TIMEOUT_MS))
  return caps?.torrent.remux === true
}

interface AppFile {
  index: number
  path: string
  name?: string
  size: number
}

interface AppTorrent {
  id: string
  name: string
  files: AppFile[]
}

interface AppStats {
  peers: number
  downBps: number
  downloaded: number
  progress: number
}

async function appJson<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${JLOCAL_ORIGIN}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: withTimeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new JlocalTorrentError(`jlocal ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (response.status === 400 && path === '/torrent/add') throw new TorrentRejectedError('invalid_infohash')
  if (!response.ok) throw new JlocalTorrentError(`jlocal ${path} ${response.status}${body.error ? ` ${body.error}` : ''}`)
  return body
}

/** Adds the magnet to the app's swarm and lists its files. */
export async function openJlocalTorrent(magnet: string, onStats?: (stats: TorrentStats) => void): Promise<TorrentSession> {
  const parsed = parseMagnet(magnet)
  if (!parsed) throw new TorrentRejectedError('invalid_infohash')
  const added = await appJson<{ id: string; name: string }>('/torrent/add', {
    method: 'POST',
    body: JSON.stringify({ magnet }),
    timeoutMs: ADD_TIMEOUT_MS,
  })
  const listing = await appJson<{ torrents: AppTorrent[] }>('/torrent/list')
  const torrent = listing.torrents.find((candidate) => candidate.id === added.id)
  if (!torrent) throw new JlocalTorrentError('jlocal lost the torrent it just added')
  const id = torrent.id
  const baseName = (path: string) => path.split(/[\\/]/).pop() || path

  let currentStats: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }
  const files = orderVideoFiles(torrent.files
    .filter((file) => VIDEO_EXTENSION.test(file.path))
    .map((file) => ({ ...file, name: file.name ?? baseName(file.path) })))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      index: file.index,
      size: file.size,
      type: 'application/octet-stream',
      get progress() { return currentStats.progress },
      get downloaded() { return currentStats.downloaded },
    }))
  const subtitleFiles = torrent.files
    .filter((file) => isSubtitleFileName(file.path) && file.size > 0 && file.size <= MAX_SIDE_FILE_BYTES)
    .map((file): TorrentSideFile => ({ name: file.name ?? baseName(file.path), path: file.path, size: file.size, index: file.index }))

  let statsTimer: ReturnType<typeof setInterval> | null = null
  const refreshStats = async () => {
    try {
      const next = await appJson<AppStats>(`/torrent/stats/${id}`)
      currentStats = { peers: next.peers, downloadSpeed: next.downBps, downloaded: next.downloaded, progress: next.progress }
      onStats?.(currentStats)
    } catch {}
  }
  onStats?.(currentStats)
  if (onStats) statsTimer = setInterval(() => { void refreshStats() }, STATS_MS)
  const stop = () => {
    if (statsTimer !== null) clearInterval(statsTimer)
    statsTimer = null
  }

  return {
    name: added.name || torrent.name || parsed.dn || 'torrent',
    magnet,
    infoHash: id,
    backend: 'jlocal',
    files,
    subtitleFiles,
    stats: () => currentStats,
    select: async (path) => {
      const file = files.find((candidate) => candidate.path === path)
      if (!file) throw new Error('torrent file not found')
      await appJson('/torrent/select', { method: 'POST', body: JSON.stringify({ id, file: file.index }), timeoutMs: 40_000 })
      if (statsTimer === null) statsTimer = setInterval(() => { void refreshStats() }, STATS_MS)
    },
    startRemux: (file, { roomId, mediaGeneration }) =>
      startJlocalProduction('torrent', { id, file: file.index }, roomId, mediaGeneration),
    // The app keeps the torrent and what it downloaded: the next room with
    // this magnet starts warm.
    destroy: stop,
    detach: stop,
  }
}
