/**
 * The host's share of a fleet production: the worker's FFmpeg makes the
 * video but never extracts subtitles, so this browser walks the torrent for
 * them through the worker's ranged reads, and only for them. No remuxer, no
 * decoders — the reader is fetch and a ticket that renews itself.
 */
import type { WorkerGrant } from '../torrent'
import { ReadGate, rangeBytes } from './rangeRead'
import { publishSubtitles, type SubtitleSideFile, type SubtitleSource } from './subtitlePublish'

export interface SubtitleScanJob {
  roomID: string
  mediaGeneration: number
  grant: WorkerGrant
  sideFiles: SubtitleSideFile[]
}

const RENEW_FRACTION = 2 / 3
const RETRY_MS = 15_000

interface WorkerReader extends SubtitleSource {
  dispose(): void
}

function workerReader(grant: WorkerGrant, roomID: string): WorkerReader {
  const gate = new ReadGate()
  let current = grant
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const renew = async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/torrents/${encodeURIComponent(current.jobId)}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: roomID }),
      })
      if (!response.ok) {
        scheduleRenewal(RETRY_MS)
        return false
      }
      const next = await response.json() as Partial<WorkerGrant>
      current = { ...current, ...next }
      scheduleRenewal()
      return true
    } catch {
      scheduleRenewal(RETRY_MS)
      return false
    }
  }
  const scheduleRenewal = (inMs?: number) => {
    if (renewTimer !== null) clearTimeout(renewTimer)
    if (disposed) return
    const life = new Date(current.expiresAt).getTime() - Date.now()
    if (!Number.isFinite(life) || life <= 0) return
    renewTimer = setTimeout(() => { void renew() }, Math.min(inMs ?? life * RENEW_FRACTION, Math.max(life - 1_000, 1_000)))
  }
  void renew()

  const opts = () => ({
    url: () => `${current.readBase}/v1/f/${current.ticket}?prio=scan`,
    size: grant.size,
    gate,
    refresh: renew,
  })
  return {
    name: grant.name,
    size: grant.size,
    read: (start, end) => rangeBytes(opts(), start, end),
    sidecarUrl: (index) => `${current.readBase}/v1/file/${current.ticket}/${index}`,
    dispose: () => {
      disposed = true
      if (renewTimer !== null) clearTimeout(renewTimer)
      gate.close()
    },
  }
}

export async function runSubtitleScan(job: SubtitleScanJob): Promise<void> {
  const reader = workerReader(job.grant, job.roomID)
  try {
    await publishSubtitles(reader, job.sideFiles, job.roomID, job.mediaGeneration, true)
  } finally {
    reader.dispose()
  }
}
