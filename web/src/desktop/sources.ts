/**
 * Torrent and YouTube through the desktop app: the swarm and yt-dlp run on
 * the host's machine, and the room plays from the app's cache (see
 * ./localRoom). The room is born `kind: "local"`; nothing touches the fleet.
 */
import { desktop } from '../platform'
import { TorrentRejectedError, orderVideoFiles, parseMagnet } from '../remoteTorrent'
import { isSubtitleFileName } from '../subtitleFormats'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile } from '../torrent'
import { YoutubeError, youtubeVideoId, type YoutubeBackend, type YoutubeSummary } from '../youtube'
import { attachLocalRoom } from './localRoom'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
const STATS_MS = 2_000

interface AppFile { index: number; path: string; size: number }
interface AppTorrent { id: string; name: string; files: AppFile[] }
interface AppStats { peers: number; downBps: number; downloaded: number; progress: number }

const baseName = (path: string) => path.split(/[\\/]/).pop() || path

async function app() {
  const found = await desktop()
  if (!found) throw new Error('desktop app unavailable')
  return found
}

/** Adds the magnet to the app's swarm and lists its files. */
export async function openDesktopTorrent(magnet: string, onStats?: (stats: TorrentStats) => void): Promise<TorrentSession> {
  const parsed = parseMagnet(magnet)
  if (!parsed) throw new TorrentRejectedError('invalid_infohash')
  const bridge = await app()
  const torrent = await bridge.invoke<AppTorrent>('torrent_open', { magnet })
  let stats: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }
  const files = orderVideoFiles(torrent.files
    .filter((file) => VIDEO_EXTENSION.test(file.path))
    .map((file) => ({ ...file, name: baseName(file.path) })))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      index: file.index,
      size: file.size,
      type: 'application/octet-stream',
      get progress() { return stats.progress },
      get downloaded() { return stats.downloaded },
    }))
  const subtitleFiles = torrent.files
    .filter((file) => isSubtitleFileName(file.path) && file.size > 0 && file.size <= MAX_SIDE_FILE_BYTES)
    .map((file): TorrentSideFile => ({ name: baseName(file.path), path: file.path, size: file.size, index: file.index }))

  let timer: ReturnType<typeof setInterval> | null = null
  const refresh = async () => {
    try {
      const next = await bridge.invoke<AppStats>('torrent_stats', { id: torrent.id })
      stats = { peers: next.peers, downloadSpeed: next.downBps, downloaded: next.downloaded, progress: next.progress }
      onStats?.(stats)
    } catch {}
  }
  const watch = () => { if (onStats && timer === null) timer = setInterval(() => { void refresh() }, STATS_MS) }
  const stop = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  onStats?.(stats)
  watch()

  return {
    name: torrent.name || parsed.dn || 'torrent',
    magnet,
    infoHash: torrent.id,
    backend: 'desktop',
    files,
    subtitleFiles,
    stats: () => stats,
    select: async (path) => {
      const file = files.find((candidate) => candidate.path === path)
      if (!file) throw new Error('torrent file not found')
      await bridge.invoke('torrent_select', { id: torrent.id, index: file.index })
      watch()
    },
    startRemux: (file, { roomId, mediaGeneration, auth }) =>
      attachLocalRoom(roomId, mediaGeneration, { kind: 'torrent', id: torrent.id, index: file.index, title: file.name }, auth),
    // What came down stays in the app: the next room with this magnet starts warm.
    destroy: stop,
    detach: stop,
  }
}

export const desktopYoutubeBackend: YoutubeBackend = {
  name: 'desktop',
  async capacity() {
    return (await desktop()) ? 'available' : 'disabled'
  },
  async resolve(url) {
    const bridge = await desktop()
    if (!bridge) throw new YoutubeError('no_workers')
    let summary: YoutubeSummary
    try {
      summary = await bridge.invoke<YoutubeSummary>('youtube_resolve', { url })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const code = detail.split(':')[0]
      if (code === 'tools_missing') throw new YoutubeError('no_workers')
      if (code.startsWith('youtube_') && code !== 'youtube_tool') throw new YoutubeError(code, detail)
      throw new YoutubeError('failed', detail)
    }
    return { url, videoId: summary.videoId || youtubeVideoId(url) || '', summary, backend: 'desktop', destroy: () => undefined }
  },
  async start(session, { roomId, mediaGeneration, auth }) {
    return await attachLocalRoom(roomId, mediaGeneration, {
      kind: 'youtube',
      url: session.url,
      videoId: session.videoId,
      title: session.summary.title,
    }, auth)
  },
}
