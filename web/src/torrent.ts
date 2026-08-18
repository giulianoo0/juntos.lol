import webTorrentBundleURL from 'webtorrent/dist/webtorrent.min.js?url'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i

interface TorrentEventTarget {
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
}

interface WebTorrentFileInternal {
  name: string
  path: string
  length: number
  type: string
  progress: number
  downloaded: number
  arrayBuffer(options: { start: number; end: number }): Promise<ArrayBuffer>
}

interface WebTorrentTorrent extends TorrentEventTarget {
  name: string
  files: WebTorrentFileInternal[]
  numPeers: number
  downloadSpeed: number
  downloaded: number
  progress: number
}

interface WebTorrentClient extends TorrentEventTarget {
  add(id: string, options: { deselect: boolean }, callback: (torrent: WebTorrentTorrent) => void): WebTorrentTorrent
  destroy(callback?: (error?: Error) => void): void
}

interface WebTorrentConstructor {
  new (): WebTorrentClient
}

let webTorrentLoader: Promise<WebTorrentConstructor> | null = null

function loadWebTorrent(): Promise<WebTorrentConstructor> {
  if (webTorrentLoader) return webTorrentLoader
  webTorrentLoader = import(/* @vite-ignore */ webTorrentBundleURL)
    .then((module: { default?: unknown }) => {
      if (typeof module.default !== 'function') throw new Error('WebTorrent did not initialize')
      return module.default as WebTorrentConstructor
    })
  return webTorrentLoader
}

export interface TorrentVideoFile {
  name: string
  path: string
  size: number
  type: string
  progress: number
  downloaded: number
  read(start: number, endInclusive: number): Promise<ArrayBuffer>
}

export interface TorrentStats {
  peers: number
  downloadSpeed: number
  downloaded: number
  progress: number
}

export interface TorrentSession {
  name: string
  files: TorrentVideoFile[]
  stats(): TorrentStats
  select(path: string): Promise<void>
  destroy(): void
}

interface BridgeResponse {
  id: string
  name: string
  magnet: string
  files: Array<{ name: string; path: string; size: number; type: string }>
  stats: TorrentStats
}

async function openBridge(magnet: string): Promise<BridgeResponse | null> {
  try {
    const response = await fetch('/api/torrent-bridge/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet }),
    })
    if (!response.ok) return null
    return await response.json() as BridgeResponse
  } catch {
    return null
  }
}

function addWebRTCTrackers(magnet: string): string {
  const value = new URL(magnet)
  const trackers = new Set(value.searchParams.getAll('tr'))
  for (const tracker of [
    'wss://tracker.btorrent.xyz',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
  ]) {
    if (!trackers.has(tracker)) value.searchParams.append('tr', tracker)
  }
  return value.toString()
}

export async function openTorrent(
  torrentID: string,
  onStats?: (stats: TorrentStats) => void,
): Promise<TorrentSession> {
  const bridge = await openBridge(torrentID)
  if (bridge) return openBridgeSession(bridge, onStats)

  const resolvedTorrentID = addWebRTCTrackers(torrentID)
  const WebTorrent = await loadWebTorrent()
  const client = new WebTorrent()

  return await new Promise<TorrentSession>((resolve, reject) => {
    let settled = false
    let timer = 0
    let metadataTimer = 0

    const fail = (value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value || 'torrent failed'))
      if (!settled) {
        settled = true
        window.clearInterval(timer)
        window.clearTimeout(metadataTimer)
        try { client.destroy() } catch { /* already destroyed */ }
        reject(error)
      }
    }

    client.once('error', fail)
    try {
      const torrent = client.add(resolvedTorrentID, { deselect: true }, (readyTorrent) => {
        if (settled) return
        settled = true
        window.clearTimeout(metadataTimer)
        const getStats = (): TorrentStats => ({
          peers: readyTorrent.numPeers,
          downloadSpeed: readyTorrent.downloadSpeed,
          downloaded: readyTorrent.downloaded,
          progress: readyTorrent.progress,
        })
        timer = window.setInterval(() => onStats?.(getStats()), 500)
        onStats?.(getStats())
        const files = readyTorrent.files
          .filter((file) => VIDEO_EXTENSION.test(file.name))
          .map((file): TorrentVideoFile => ({
            name: file.name,
            path: file.path,
            size: file.length,
            type: file.type || 'application/octet-stream',
            get progress() { return file.progress },
            get downloaded() { return file.downloaded },
            read: (start, endInclusive) => file.arrayBuffer({ start, end: endInclusive }),
          }))
          .sort((a, b) => b.size - a.size)

        resolve({
          name: readyTorrent.name,
          files,
          stats: getStats,
          select: async (path) => {
            const file = files.find((candidate) => candidate.path === path)
            if (!file) throw new Error('torrent file not found')
          },
          destroy: () => {
            window.clearInterval(timer)
            try { client.destroy() } catch { /* already destroyed */ }
          },
        })
      })
      torrent.once('error', fail)
      metadataTimer = window.setTimeout(() => fail(new Error('torrent metadata timeout')), 30_000)
    } catch (error) {
      fail(error)
    }
  })
}

function openBridgeSession(
  bridge: BridgeResponse,
  onStats?: (stats: TorrentStats) => void,
): TorrentSession {
  let selectedPath = ''
  let downloaded = 0
  let currentStats = bridge.stats
  let destroyed = false

  const request = async (path: 'select' | 'stats' | 'read', body: Record<string, unknown>): Promise<Response> => {
    const response = await fetch(`/api/torrent-bridge/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bridge.id, ...body }),
    })
    if (!response.ok) throw new Error(`torrent bridge ${path} failed (${response.status})`)
    return response
  }

  const files = bridge.files
    .filter((file) => VIDEO_EXTENSION.test(file.name))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      size: file.size,
      type: file.type || 'application/octet-stream',
      get progress() { return selectedPath === file.path && file.size > 0 ? downloaded / file.size : 0 },
      get downloaded() { return selectedPath === file.path ? downloaded : 0 },
      read: async (start, endInclusive) => {
        if (destroyed) throw new Error('torrent session closed')
        if (selectedPath !== file.path) throw new Error('torrent file not selected')
        const response = await request('read', { start, end: endInclusive })
        const data = await response.arrayBuffer()
        const expected = endInclusive - start + 1
        if (data.byteLength !== expected) throw new Error(`incomplete torrent read (${data.byteLength}/${expected})`)
        downloaded = Math.max(downloaded, endInclusive + 1)
        currentStats = { ...currentStats, downloaded, progress: downloaded / file.size }
        onStats?.(currentStats)
        return data
      },
    }))
    .sort((a, b) => b.size - a.size)

  const refreshStats = async () => {
    try {
      const response = await request('stats', {})
      const stats = await response.json() as TorrentStats
      currentStats = { ...stats, downloaded: Math.max(stats.downloaded, downloaded) }
      onStats?.(currentStats)
    } catch {
      // A byte read reports actionable errors. Stats are best effort only.
    }
  }
  onStats?.(currentStats)
  const statsTimer = window.setInterval(() => { void refreshStats() }, 1_000)

  return {
    name: bridge.name,
    files,
    stats: () => currentStats,
    select: async (path) => {
      if (!files.some((file) => file.path === path)) throw new Error('torrent file not found')
      await request('select', { path })
      selectedPath = path
      downloaded = 0
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.clearInterval(statsTimer)
      void fetch('/api/torrent-bridge/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bridge.id }),
        keepalive: true,
      }).catch(() => undefined)
    },
  }
}
