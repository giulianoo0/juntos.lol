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
  /** A fresh mediabunny source over the same bytes. */
  source(): Source
  /** Rejects every read in flight with ReadAbortedError; later reads run. */
  abortReads(): void
  /** Aborts and refuses every read from now on. */
  dispose(): void
}

/** The cache a remote source keeps: larger than the prefetch extent, or the
 * two fight and every sequential pass rereads what it just dropped. */
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

/**
 * A torrent file served by the ss-bridge on loopback. The helper's reads
 * take no signal, so an abort here rejects the caller and lets the helper
 * finish on its own; the whole path goes away with the helper.
 */
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

/**
 * Bytes at a url that answers Range requests: a plugin's stream, or the
 * dev fixture standing in for a worker. Every read streams the body as it
 * arrives, resumes across capped or truncated responses, and retries
 * blips — mediabunny only ever sees the bytes it asked for, or an abort.
 * The priority rides in the query string so the request stays a simple
 * GET with no preflight.
 */
export function rangeInput(url: string, name: string, size: number): MediaInput {
  const gate = new ReadGate()
  const opts = (hint?: ReadHint) => ({
    url: () => (hint?.prio ? withParam(url, 'prio', hint.prio) : url),
    size,
    gate,
  })
  return {
    name,
    size,
    read: (start, end, hint) => rangeBytes(opts(hint), start, end),
    source: () => new CustomSource({
      read: (start, end) => rangeStream(opts({ prio: 'playhead' }), start, end),
      getSize: async () => size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => gate.abort(),
    dispose: () => gate.close(),
  }
}

// How far the remux's read offset may drift from the last hint before the
// worker is told again. Hints move the swarm's priority window; too many
// would move it for nothing.
const HINT_STRIDE_BYTES = 8 * 1024 * 1024
// A ticket is renewed at two thirds of its life, so a read never starts
// with one about to expire.
const RENEW_FRACTION = 2 / 3

/**
 * A file a remote worker serves. Reads carry the ticket in the path and
 * the priority class in the query; the ticket renews itself through the
 * server for as long as the input lives, and playhead reads tell the
 * worker where the remux actually is — its read offset, not the room's
 * playhead — so the swarm fetches the pieces the reader is blocked on.
 * Each seek bumps the generation, and the worker stops feeding responses
 * from before it.
 */
export function workerInput(grant: WorkerGrant): MediaInput {
  const gate = new ReadGate()
  let current = grant
  let gen = 1
  let lastHintAt = -Infinity
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const renew = async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/torrents/${encodeURIComponent(current.jobId)}/token`, { method: 'POST' })
      if (!response.ok) return false
      const next = await response.json() as Partial<WorkerGrant>
      current = { ...current, ...next }
      scheduleRenewal()
      return true
    } catch {
      return false
    }
  }
  const scheduleRenewal = () => {
    if (renewTimer !== null) clearTimeout(renewTimer)
    if (disposed) return
    const life = new Date(current.expiresAt).getTime() - Date.now()
    if (!Number.isFinite(life) || life <= 0) return
    renewTimer = setTimeout(() => { void renew() }, life * RENEW_FRACTION)
  }
  scheduleRenewal()

  const hint = (offset: number) => {
    if (Math.abs(offset - lastHintAt) < HINT_STRIDE_BYTES) return
    lastHintAt = offset
    // text/plain keeps the POST a simple request: no preflight per hint.
    void fetch(`${current.readBase}/v1/hint/${current.ticket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ readOffset: offset, gen }),
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
    read: (start, end, hint_) => rangeBytes(opts(hint_?.prio ?? 'head'), start, end),
    source: () => new CustomSource({
      read: (start, end) => {
        hint(start)
        return rangeStream(opts('playhead'), start, end)
      },
      getSize: async () => grant.size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => {
      gen += 1
      lastHintAt = -Infinity
      gate.abort()
    },
    dispose: () => {
      disposed = true
      if (renewTimer !== null) clearTimeout(renewTimer)
      gate.close()
    },
  }
}

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`
}
