/**
 * What the client pipeline reads from. Every source this browser remuxes —
 * a picked file, a url a plugin handed over — is reduced to the same two
 * things: a size, and a way to read any byte range. The remuxer does random
 * access (an MKV's cues sit at the end, an MP4's moov often does), so a
 * sequential stream would not do.
 *
 * Remote reads can also be abandoned: a seek moves the remux somewhere
 * else, and the reads parked on the old region must stop holding the
 * origin's attention. mediabunny hands `read` no signal, so the input owns a
 * gate the seek pulls.
 */
import { BlobSource, CustomSource, type Source } from 'mediabunny'
import { ByteTap, teeInto } from './byteTap'
import { ReadGate, rangeBytes, rangeStream } from './rangeRead'

/** What a read is for; a remote origin uses it to order its work. */
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

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`
}
