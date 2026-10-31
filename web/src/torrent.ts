import { mockOpenTorrent, mocksEnabled } from './mocks'
import { TorrentRejectedError, openRemoteTorrent, torrentCapacity as fleetCapacity, type OpenTorrentOptions } from './remoteTorrent'
import { jlocalTorrentUsable, openJlocalTorrent } from './jlocal/torrent'
import { openDesktopTorrent } from './desktop/sources'
import { desktop } from './platform'

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
  /** The seat opening it, which the app's subtitles go up as. */
  auth?: { memberId: string; capability: string }
}

export interface TorrentSession {
  name: string
  magnet?: string
  jobId?: string
  infoHash?: string
  /** Who holds the swarm: the fleet's worker (default) or the companion app. */
  backend?: 'fleet' | 'jlocal' | 'desktop'
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

const APP_SWARM_DEADLINE_MS = 25_000

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('torrent metadata timed out')), ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Opens the magnet where it will be prepared: the desktop app when it carries
 * the page, the companion app when it can take it, the fleet otherwise. An app
 * failing for any reason but the magnet itself hands it to the fleet.
 */
export async function openTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
  options?: OpenTorrentOptions,
): Promise<TorrentSession> {
  if (mocksEnabled) return mockOpenTorrent(onStats)
  // Inside the desktop app the swarm is the host's own, and so is the room; a network that
  // drops UDP leaves it without DHT or most trackers, and then the fleet opens it instead.
  if (await desktop()) {
    try {
      return await withinDeadline(openDesktopTorrent(magnet, onStats), APP_SWARM_DEADLINE_MS)
    } catch (error) {
      if (error instanceof TorrentRejectedError) throw error
      console.warn('the app could not reach the swarm; trying the fleet', error)
    }
    return await openRemoteTorrent(magnet, onStats, options)
  }
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
  if (!mocksEnabled && (await desktop() || await jlocalTorrentUsable())) return 'available'
  return await fleetCapacity()
}
