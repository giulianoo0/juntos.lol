// What the page says for each way a torrent can fail to open. Kept apart
// from the client so the three pages that open torrents agree on it.
import { NoWorkersError, TorrentQuotaError, TorrentRejectedError, WorkersBusyError } from './remoteTorrent'

export function isTorrentError(error: unknown): boolean {
  return error instanceof NoWorkersError || error instanceof WorkersBusyError
    || error instanceof TorrentRejectedError || error instanceof TorrentQuotaError
}

/** Only a torrent the fleet refused for good is not worth retrying. */
export function torrentErrorRetryable(error: unknown): boolean {
  return !(error instanceof TorrentRejectedError)
}

export function torrentErrorKey(error: unknown): string {
  if (error instanceof NoWorkersError) return 'home.torrentNoWorkers'
  if (error instanceof WorkersBusyError) return 'home.torrentBusy'
  if (error instanceof TorrentQuotaError) return 'home.torrentQuota'
  if (error instanceof TorrentRejectedError) {
    if (error.code === 'not_video') return 'home.torrentNotVideo'
    if (error.code === 'no_metadata') return 'home.torrentNoSeeds'
    return 'home.torrentRejected'
  }
  return 'home.torrentFailed'
}
