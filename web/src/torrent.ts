import { mockOpenTorrent, mocksEnabled } from './mocks'
import { openRemoteTorrent, type OpenTorrentOptions } from './remoteTorrent'

export { NoWorkersError, TorrentQuotaError, TorrentRejectedError, WorkersBusyError, parseMagnet, probeWorkers } from './remoteTorrent'
export type { OpenTorrentOptions, WorkerProbe } from './remoteTorrent'

/** Where a worker serves a selected file from, with the ticket that rotates. */
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
  index: number
  size: number
  type: string
  progress: number
  downloaded: number
  worker?: WorkerGrant
  read(start: number, endInclusive: number): Promise<ArrayBuffer>
}

// A small non-video file shipped in the same torrent, read in full.
export interface TorrentSideFile {
  name: string
  path: string
  size: number
  index?: number
  streamUrl?: string
  read(): Promise<ArrayBuffer>
}

export interface TorrentStats {
  peers: number
  downloadSpeed: number
  downloaded: number
  progress: number
  // What the disk holds now, unlike `downloaded`, which only ever grows.
  diskBytes?: number
}

export interface TorrentSession {
  name: string
  magnet?: string
  jobId?: string
  files: TorrentVideoFile[]
  subtitleFiles: TorrentSideFile[]
  stats(): TorrentStats
  select(path: string): Promise<void>
  /** Rejects every read in flight; the seek moved on. */
  abortReads?(): void
  destroy(): void
  /** Stops this tab's polling and readers without releasing the server-side
   * job: the room's production moved to the worker and still needs it. */
  detach?(): void
}

/**
 * Places the magnet on a worker; nothing is downloaded on this machine. The
 * error type says whether the failure is worth retrying.
 */
export async function openTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
  options?: OpenTorrentOptions,
): Promise<TorrentSession> {
  if (mocksEnabled) return mockOpenTorrent(onStats)
  return await openRemoteTorrent(magnet, onStats, options)
}
