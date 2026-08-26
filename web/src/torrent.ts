import { mockOpenTorrent, mocksEnabled } from './mocks'
import { openRemoteTorrent, type OpenTorrentOptions } from './remoteTorrent'

export { NoWorkersError, TorrentQuotaError, TorrentRejectedError, WorkersBusyError, parseMagnet, probeWorkers } from './remoteTorrent'
export type { OpenTorrentOptions, WorkerProbe } from './remoteTorrent'

/**
 * Where a worker serves a selected file from. Everything a remux job needs
 * to read the bytes and keep reading them for hours: the base, the ticket
 * that rotates, and the job the next ticket is asked for.
 */
export interface WorkerGrant {
  jobId: string
  readBase: string
  ticket: string
  expiresAt: string
  name: string
  size: number
  fileIndex: number
}

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
  // Where the bytes are served from once this file is selected on a worker.
  // What lets the remux worker read the swarm without the page in between.
  worker?: WorkerGrant
  read(start: number, endInclusive: number): Promise<ArrayBuffer>
}

// A small non-video file shipped in the same torrent, read in full. Releases
// put their subtitles here instead of muxing them into the container.
export interface TorrentSideFile {
  name: string
  path: string
  size: number
  // Position in the torrent's file list, for a worker to serve it by.
  index?: number
  streamUrl?: string
  read(): Promise<ArrayBuffer>
}

export interface TorrentStats {
  peers: number
  downloadSpeed: number
  downloaded: number
  progress: number
  // What the worker's disk is really holding for this torrent. `downloaded`
  // only grows — it is everything that ever came off the swarm — while the
  // window hands blocks back as the reader passes them, so this is the one
  // that answers "how much storage is this room using".
  diskBytes?: number
}

export interface TorrentSession {
  name: string
  // The magnet this session was opened from — what a reloaded host needs to
  // reopen the same swarm and resume preparing the room.
  magnet?: string
  // The server-side job behind this session, when there is one.
  jobId?: string
  files: TorrentVideoFile[]
  subtitleFiles: TorrentSideFile[]
  stats(): TorrentStats
  select(path: string): Promise<void>
  /** Rejects every read in flight; the seek moved on. */
  abortReads?(): void
  destroy(): void
}

/**
 * Opens a magnet on the worker fleet. Nothing on this machine downloads a
 * swarm: the server places the torrent on a worker, and the bytes come from
 * there. The errors say which of three things went wrong — no fleet, a full
 * fleet, or a torrent the fleet will not carry — so the caller can tell a
 * moment to retry from a thing to give up on.
 */
export async function openTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
  options?: OpenTorrentOptions,
): Promise<TorrentSession> {
  if (mocksEnabled) return mockOpenTorrent(onStats)
  return await openRemoteTorrent(magnet, onStats, options)
}
