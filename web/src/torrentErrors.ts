// What the page says for each way a torrent can fail to open. Kept apart
// from the client so the three pages that open torrents agree on it.
import { NoWorkersError, TorrentQuotaError, TorrentRejectedError, WorkersBusyError } from './remoteTorrent'

export function isTorrentError(error: unknown): boolean {
  return error instanceof NoWorkersError || error instanceof WorkersBusyError
    || error instanceof TorrentRejectedError || error instanceof TorrentQuotaError
}

/** Whether the same magnet is worth trying again later, unchanged. */
export function torrentErrorRetryable(error: unknown): boolean {
  return error instanceof NoWorkersError || error instanceof WorkersBusyError || error instanceof TorrentQuotaError
}

export function torrentErrorKey(error: unknown): string {
  if (error instanceof NoWorkersError) return 'home.torrentNoWorkers'
  if (error instanceof WorkersBusyError) return 'home.torrentBusy'
  if (error instanceof TorrentQuotaError) return 'home.torrentQuota'
  if (error instanceof TorrentRejectedError) return error.code === 'not_video' ? 'home.torrentNotVideo' : 'home.torrentRejected'
  return 'home.torrentFailed'
}
