import { mockOpenTorrent, mocksEnabled } from './mocks'
import { helperAvailable, openHelperTorrent } from './localHelper'

export interface TorrentVideoFile {
  name: string
  path: string
  // Position in the torrent's own file list, before any filtering or sorting.
  // Stream addons address files by this index.
  index: number
  size: number
  type: string
  progress: number
  downloaded: number
  // Where the helper serves this file's bytes over HTTP Range, when it does.
  // What lets the remux worker read the swarm without the page in between.
  streamUrl?: string
  read(start: number, endInclusive: number): Promise<ArrayBuffer>
}

// A small non-video file shipped in the same torrent, read in full. Releases
// put their subtitles here instead of muxing them into the container.
export interface TorrentSideFile {
  name: string
  path: string
  size: number
  streamUrl?: string
  read(): Promise<ArrayBuffer>
}

export interface TorrentStats {
  peers: number
  downloadSpeed: number
  downloaded: number
  progress: number
}

export interface TorrentSession {
  name: string
  // The magnet this session was opened from — what a reloaded host needs to
  // reopen the same swarm and resume preparing the room.
  magnet?: string
  files: TorrentVideoFile[]
  subtitleFiles: TorrentSideFile[]
  stats(): TorrentStats
  select(path: string): Promise<void>
  destroy(): void
}

/**
 * Thrown when a torrent is asked for and the ss helper is not there to open
 * it. It is the only way a torrent gets opened — nothing on the server and
 * nothing in the browser downloads a swarm — so the caller's job on seeing
 * this is to point at the helper, not to retry.
 */
export class HelperRequiredError extends Error {
  constructor() {
    super('ss-bridge is not running')
    this.name = 'HelperRequiredError'
  }
}

export async function openTorrent(
  torrentID: string,
  onStats?: (stats: TorrentStats) => void,
): Promise<TorrentSession> {
  if (mocksEnabled) return mockOpenTorrent(onStats)
  // The helper is the whole torrent path: it downloads on the host's own
  // machine and streams the bytes here, and the room uploads from there.
  if (!await helperAvailable()) throw new HelperRequiredError()
  return await openHelperTorrent(torrentID, onStats)
}
