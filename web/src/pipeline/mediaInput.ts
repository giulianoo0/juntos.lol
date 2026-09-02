/**
 * What the client pipeline reads from. Every source the site can play — a
 * picked file, a torrent a worker is downloading, a url a plugin handed
 * over — is reduced to the same two things: a size, and a way to read any
 * byte range. The remuxer does random access (an MKV's cues sit at the end,
 * an MP4's moov often does), so a sequential stream would not do.
 *
 * Remote reads can also be abandoned: a seek moves the remux somewhere
 * else, and the reads parked on the old region must stop holding the
 * origin's attention. mediabunny hands `read` no signal, so the input owns a
 * gate the seek pulls.
 */
import { BlobSource, CustomSource, type Source } from 'mediabunny'
import type { TorrentVideoFile, WorkerGrant } from '../torrent'
import { ByteTap, teeInto } from './byteTap'
import { ReadGate, rangeBytes, rangeStream } from './rangeRead'

/** What a read is for; a remote origin uses it to order its swarm. */
export type ReadPriority = 'head' | 'playhead' | 'scan'

export interface ReadHint {
  prio?: ReadPriority
}

export interface MediaInput {
  name: string
  size: number
  /** Reads `[start, end)`, like `Blob.slice`. */
  read(start: number, end: number, hint?: ReadHint): Promise<Uint8Array>
  source(): Source
  /** Rejects every read in flight with ReadAbortedError; later reads run. */
  abortReads(): void
  dispose(): void
  sidecarUrl?(index: number): string
  /** Says where reading is about to resume, before anything reads there, so a
   * remote origin can move its window ahead of the seek's first read. */
  prefetchAt?(offset: number): void
  tap?: ByteTap
}

const REMOTE_CACHE_BYTES = 96 * 2 ** 20

export function fileInput(file: File): MediaInput {
  return {
    name: file.name,
    size: file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    source: () => new BlobSource(file),
    abortReads: () => {},
    dispose: () => {},
  }
}

/** A torrent file behind a session's own `read`: that read takes no signal,
 * so an abort here rejects the caller and lets the read finish on its own. */
export function torrentInput(file: TorrentVideoFile): MediaInput {
  const gate = new ReadGate()
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const clamped = Math.min(end, file.size)
    if (clamped <= start) return new Uint8Array(0)
    const signal = gate.signal
    if (signal.aborted) throw gate.aborted()
    return await new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = () => reject(gate.aborted())
      signal.addEventListener('abort', onAbort, { once: true })
      file.read(start, clamped - 1).then(
        (buffer) => { signal.removeEventListener('abort', onAbort); resolve(new Uint8Array(buffer)) },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
  }
  return {
    name: file.name,
    size: file.size,
    read,
    source: () => new CustomSource({
      read,
      getSize: async () => file.size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => gate.abort(),
    dispose: () => gate.close(),
  }
}

/** Bytes at a url that answers Range requests. Every read streams the body as
 * it arrives, resumes across capped or truncated responses, and retries blips;
 * the priority rides in the query string so the GET needs no preflight. */
export function rangeInput(url: string, name: string, size: number): MediaInput {
  const gate = new ReadGate()
  const tap = new ByteTap()
  const opts = (hint?: ReadHint) => ({
    url: () => (hint?.prio ? withParam(url, 'prio', hint.prio) : url),
    size,
    gate,
  })
  return {
    name,
    size,
    tap,
    read: (start, end, hint) => rangeBytes(opts(hint), start, end),
    source: () => new CustomSource({
      read: (start, end) => teeInto(tap, start, rangeStream(opts({ prio: 'playhead' }), start, end)),
      getSize: async () => size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => gate.abort(),
    dispose: () => { tap.close(); gate.close() },
  }
}

const HINT_STRIDE_BYTES = 8 * 1024 * 1024
const RENEW_FRACTION = 2 / 3

// Generations never restart: the worker keeps a floor per reader and a torrent
// outlives the pipeline that warmed it, so a count starting at one again would
// have every playhead read refused. They carry on from the wall clock instead.
let lastGeneration = 0
function nextGeneration(): number {
  lastGeneration = Math.max(Date.now(), lastGeneration + 1)
  return lastGeneration
}

/** A file a remote worker serves. Reads carry the ticket in the path and the
 * priority in the query; the ticket renews itself for as long as the input
 * lives, and playhead reads tell the worker the remux's own read offset. */
export function workerInput(grant: WorkerGrant, roomID = ''): MediaInput {
  const gate = new ReadGate()
  const tap = new ByteTap()
  let current = grant
  let gen = nextGeneration()
  let lastHintAt = -Infinity
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const RETRY_MS = 15_000
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
  if (roomID) void renew()
  else scheduleRenewal()

  const hint = (offset: number, seek: boolean) => {
    if (!seek && Math.abs(offset - lastHintAt) < HINT_STRIDE_BYTES) return
    lastHintAt = offset
    void fetch(`${current.readBase}/v1/hint/${current.ticket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ readOffset: offset, gen, seek }),
    }).catch(() => undefined)
  }

  const opts = (prio: ReadPriority) => ({
    url: () => `${current.readBase}/v1/f/${current.ticket}?prio=${prio}&gen=${gen}`,
    size: grant.size,
    gate,
    refresh: renew,
  })
  return {
    name: grant.name,
    size: grant.size,
    tap,
    read: (start, end, hint_) => rangeBytes(opts(hint_?.prio ?? 'head'), start, end),
    source: () => new CustomSource({
      read: (start, end) => {
        hint(start, false)
        return teeInto(tap, start, rangeStream(opts('playhead'), start, end))
      },
      getSize: async () => grant.size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => {
      gen = nextGeneration()
      lastHintAt = -Infinity
      gate.abort()
    },
    dispose: () => {
      disposed = true
      if (renewTimer !== null) clearTimeout(renewTimer)
      tap.close()
      gate.close()
    },
    sidecarUrl: (index) => `${current.readBase}/v1/file/${current.ticket}/${index}`,
    prefetchAt: (offset) => hint(Math.min(Math.max(offset, 0), Math.max(grant.size - 1, 0)), true),
  }
}

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`
}
