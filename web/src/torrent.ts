import { mockOpenTorrent, mocksEnabled } from './mocks'
import { TorrentRejectedError, openRemoteTorrent, torrentCapacity as fleetCapacity, type OpenTorrentOptions } from './remoteTorrent'
import { jlocalTorrentUsable, openJlocalTorrent } from './jlocal/torrent'

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
}

// A small non-video file shipped in the same torrent.
export interface TorrentSideFile {
  name: string
  path: string
  size: number
  index?: number
}

export interface TorrentStats {
  peers: number
  downloadSpeed: number
  downloaded: number
  progress: number
  diskBytes?: number
}

export interface TorrentStart {
  roomId: string
  mediaGeneration: number
}

export interface TorrentSession {
  name: string
  magnet?: string
  jobId?: string
  infoHash?: string
  /** Who holds the swarm: the fleet's worker (default) or the companion app. */
  backend?: 'fleet' | 'jlocal'
  /** Produces the room where the swarm is, when that is not the fleet;
   * resolves null on an accepted handoff, or with the refusal. */
  startRemux?(file: TorrentVideoFile, start: TorrentStart): Promise<string | null>
  files: TorrentVideoFile[]
  subtitleFiles: TorrentSideFile[]
  stats(): TorrentStats
  select(path: string): Promise<void>
  destroy(): void
  /** Stops this tab's polling without releasing the server-side job: the
   * room's production runs on the worker and still needs it. */
  detach?(): void
}

/**
 * Opens the magnet where it will be prepared: the companion app when it can
 * take it, the fleet otherwise. The app failing for any reason but the
 * magnet itself hands the magnet to the fleet as before.
 */
export async function openTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
  options?: OpenTorrentOptions,
): Promise<TorrentSession> {
  if (mocksEnabled) return mockOpenTorrent(onStats)
  if (await jlocalTorrentUsable()) {
    try {
      return await openJlocalTorrent(magnet, onStats)
    } catch (error) {
      if (error instanceof TorrentRejectedError) throw error
      console.warn('jlocal could not open the torrent; trying the fleet', error)
    }
  }
  return await openRemoteTorrent(magnet, onStats, options)
}

/** available, busy, no_workers or disabled; the companion app counts as available. */
export async function torrentCapacity(): Promise<string> {
  if (!mocksEnabled && await jlocalTorrentUsable()) return 'available'
  return await fleetCapacity()
}
