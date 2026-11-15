/**
 * An HLS stream read as one file. The segments of a media playlist, laid end
 * to end, are a valid stream on their own (MPEG-TS packets, or an fMP4 init
 * followed by its fragments), so the pipeline reads them as a single virtual
 * file: each segment is measured once and, when it is a file of its own, read
 * whole and kept for a while (CDNs that sign segments often ignore Range);
 * EXT-X-BYTERANGE pieces of one big file are read by Range.
 *
 * Every request refuses redirects: the playlist's hosts were checked, where a
 * redirect would lead was not. A refused redirect, like a CDN without CORS,
 * sends the whole opening through a relay (the extension's media proxy, which
 * checks each hop, or the desktop app's).
 *
 * Opening (`openHls`) is the time-critical part: a signed playlist url can
 * expire within seconds, so the caller opens the plan as soon as it has the
 * url and hands the plain-data plan to wherever the remux runs.
 *
 * Segment signatures can run out long before the remux reaches them (one CDN
 * signs each segment for 30 s and answers 400 after). A segment refused that
 * way asks `renew` for the same playlist signed again, and every segment url
 * is swapped for its fresh one by position.
 */
import { CustomSource } from 'mediabunny'
import { ByteTap, teeInto } from './byteTap'
import type { MediaInput } from './mediaInput'
import { probeSize, type ProbeMemo } from './probeSize'
import { ReadGate, rangeBytes, rangeStream, type RangeReaderOptions } from './rangeRead'
import { UnsupportedMediaError } from './unsupported'

export interface HlsSegment {
  url: string
  /** Where the segment starts inside the resource at `url` (EXT-X-BYTERANGE). */
  offset: number
  size: number
  /** The segment is the whole resource at `url`, read in one request. */
  whole: boolean
}

/** Plain data: crosses into the remux worker as it is. */
export interface HlsPlan {
  segments: HlsSegment[]
  size: number
  /** The playlist's own length, the sum of its EXTINF; absent when a segment has none. */
  seconds?: number
}

/**
 * Reads for us what the browser may not: the extension's media proxy (a
 * ticket from juntos per url) or the desktop app's, on the person's network.
 */
export interface MediaRelay {
  /** The url to read `url` through. */
  via(url: string): Promise<string>
  /** Whether `url` already goes through this relay, as the segments of a playlist it rewrote do. */
  owns(url: string): boolean
}

export interface HlsOptions {
  fetch?: typeof fetch
  /** Where to read from when the CDN sends no CORS or redirects. */
  relay?: MediaRelay
  /** Whether the playlist may lead to `url`: a variant or segment anywhere else stops the opening. */
  allow?: (url: string) => boolean
}

/** The segment urls of the same playlist, signed again, in order; null when there are none. */
export type HlsRenew = () => Promise<string[] | null>

const MEASURE_AT_ONCE = 32
const REMOTE_CACHE_BYTES = 96 * 2 ** 20
const WHOLE_SEGMENTS_KEPT = 4

/** `get` that never follows a redirect: it fails like a CORS refusal does. */
function strict(get: typeof fetch): typeof fetch {
  return (input, init) => get(input, { ...init, redirect: 'error' })
}

function attributes(line: string): Map<string, string> {
  const found = new Map<string, string>()
  const body = line.slice(line.indexOf(':') + 1)
  for (const match of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    found.set(match[1], match[2].startsWith('"') ? match[2].slice(1, -1) : match[2])
  }
  return found
}

function byteRange(spec: string, url: string, after: Map<string, number>): { offset: number; size: number } {
  const [length, at] = spec.split('@')
  const size = Number(length)
  const offset = at === undefined ? after.get(url) ?? 0 : Number(at)
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size <= 0 || offset < 0) throw new Error(`bad byte range ${spec}`)
  after.set(url, offset + size)
  return { offset, size }
}

async function playlistText(url: string, get: typeof fetch): Promise<string> {
  const response = await get(url, {})
  if (!response.ok) throw new Error(`playlist answered ${response.status}`)
  const text = await response.text()
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('not an HLS playlist')
  return text
}

/**
 * A master playlist's heaviest variant, or null when this is a media playlist.
 * Audio in a playlist of its own (EXT-X-MEDIA with a URI) is a second stream
 * this reader cannot lay next to the video, so a variant that carries its
 * own audio wins, and without one the stream is refused.
 */
function heaviestVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const separateAudio = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue
    const media = attributes(line)
    if (media.get('TYPE') === 'AUDIO' && media.has('URI')) separateAudio.add(media.get('GROUP-ID') ?? '')
  }
  let best: { bandwidth: number; uri: string } | null = null
  let skipped = false
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const uri = lines.slice(index + 1).find((next) => next !== '' && !next.startsWith('#'))
    if (!uri) continue
    const variant = attributes(line)
    const audio = variant.get('AUDIO')
    if (audio !== undefined && separateAudio.has(audio)) { skipped = true; continue }
    const bandwidth = Number(variant.get('BANDWIDTH') ?? 0)
    if (!best || bandwidth > best.bandwidth) best = { bandwidth, uri }
  }
  if (best === null && skipped) throw new UnsupportedMediaError('separate audio')
  return best === null ? null : new URL(best.uri, base).href
}

type Pending = { url: string; offset: number; size: number | null; whole: boolean }

function mediaSegments(text: string, base: string): { pending: Pending[]; seconds: number | null } {
  const out: Pending[] = []
  let seconds: number | null = 0
  let timed = false
  const after = new Map<string, number>()
  let range: string | null = null
  let mapped = false
  let ended = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line === '#EXT-X-ENDLIST') { ended = true; continue }
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const method = attributes(line).get('METHOD') ?? 'NONE'
      if (method !== 'NONE') throw new UnsupportedMediaError('encrypted')
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      // One init leads the file; a second one starts another stream inside it.
      if (mapped) throw new UnsupportedMediaError('several init segments')
      mapped = true
      const map = attributes(line)
      const uri = map.get('URI')
      if (!uri) throw new Error('EXT-X-MAP without URI')
      const url = new URL(uri, base).href
      const spec = map.get('BYTERANGE')
      out.push(spec ? { url, ...byteRange(spec, url, after), whole: false } : { url, offset: 0, size: null, whole: true })
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice('#EXT-X-BYTERANGE:'.length)
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      const length = Number(line.slice('#EXTINF:'.length).split(',')[0])
      timed = Number.isFinite(length) && length >= 0
      if (seconds !== null && timed) seconds += length
      continue
    }
    if (line.startsWith('#')) continue
    if (!timed) seconds = null
    timed = false
    const url = new URL(line, base).href
    out.push(range ? { url, ...byteRange(range, url, after), whole: false } : { url, offset: 0, size: null, whole: true })
    range = null
  }
  // Without an end it is a live window, which grows while it is read.
  if (!ended) throw new UnsupportedMediaError('live')
  if (out.length === (mapped ? 1 : 0)) throw new Error('playlist has no segments')
  return { pending: out, seconds: seconds !== null && seconds > 0 ? seconds : null }
}

async function measure(pending: Pending[], get: typeof fetch): Promise<HlsSegment[]> {
  const out: HlsSegment[] = new Array(pending.length)
  const memo: ProbeMemo = { headRefused: false }
  let next = 0
  const lane = async () => {
    while (next < pending.length) {
      const index = next++
      const segment = pending[index]
      const size = segment.size ?? (await probeSize(segment.url, { fetch: get, memo })).size
      out[index] = { url: segment.url, offset: segment.offset, size, whole: segment.whole }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEASURE_AT_ONCE, pending.length) }, lane))
  return out
}

function checked(url: string, allow: HlsOptions['allow']): string {
  if (allow && !allow(url)) throw new Error(`playlist leads outside the extension's hosts: ${new URL(url).host}`)
  return url
}

async function segmentsFrom(url: string, get: typeof fetch, allow: HlsOptions['allow']): Promise<{ pending: Pending[]; seconds: number | null }> {
  let base = url
  let text = await playlistText(base, get)
  const variant = heaviestVariant(text, base)
  if (variant !== null) {
    base = checked(variant, allow)
    text = await playlistText(base, get)
  }
  const listed = mediaSegments(text, base)
  for (const segment of listed.pending) checked(segment.url, allow)
  return listed
}

async function planFrom(url: string, get: typeof fetch, allow: HlsOptions['allow']): Promise<HlsPlan> {
  const { pending, seconds } = await segmentsFrom(url, get, allow)
  const segments = await measure(pending, get)
  const plan: HlsPlan = { segments, size: segments.reduce((total, segment) => total + segment.size, 0) }
  if (seconds !== null) plan.seconds = seconds
  return plan
}

async function directOrRelayed<T>(url: string, { fetch: get = fetch, relay, allow }: HlsOptions, open: (url: string, get: typeof fetch, allow: HlsOptions['allow']) => Promise<T>): Promise<T> {
  const direct = strict(get)
  try {
    return await open(url, direct, allow)
  } catch (error) {
    // A TypeError is the browser refusing to show an answer, anywhere from the
    // playlist to the last segment: no CORS, or a redirect.
    if (!(error instanceof TypeError) || !relay) throw error
    return await open(await relay.via(url), direct, allow)
  }
}

/** Resolves the playlist to its segments and their sizes. */
export function openHls(url: string, opts: HlsOptions = {}): Promise<HlsPlan> {
  return directOrRelayed(url, opts, planFrom)
}

/** The segment urls of a playlist opened again, without measuring them: the sizes are the plan's. */
export async function reopenHls(url: string, opts: HlsOptions = {}): Promise<string[]> {
  return (await directOrRelayed(url, opts, segmentsFrom)).pending.map((segment) => segment.url)
}

export async function hlsInput(url: string, name: string, opts: HlsOptions & { plan?: HlsPlan; renew?: HlsRenew } = {}): Promise<MediaInput> {
  const plan = opts.plan ?? await openHls(url, opts)
  const { segments, size } = plan
  const starts: number[] = []
  segments.reduce((at, segment) => { starts.push(at); return at + segment.size }, 0)
  const gate = new ReadGate()
  const tap = new ByteTap()
  const get = strict(opts.fetch ?? fetch)

  // Bumped on every renewal: a read refused under an older signature only retries.
  const urls = segments.map((segment) => segment.url)
  let signing = 0
  let renewing: Promise<boolean> | null = null
  const renewFrom = (seen: number): Promise<boolean> => {
    if (seen !== signing) return Promise.resolve(true)
    const { renew } = opts
    if (!renew) return Promise.resolve(false)
    renewing ??= renew()
      .then((fresh) => {
        if (!fresh || fresh.length !== urls.length) return false
        fresh.forEach((url, index) => { urls[index] = url })
        signing += 1
        return true
      })
      .catch(() => false)
      .finally(() => { renewing = null })
    return renewing
  }
  const reading = (index: number, total: number): RangeReaderOptions => {
    let seen = signing
    return {
      url: () => { seen = signing; return urls[index] },
      refresh: () => renewFrom(seen),
      size: total,
      gate,
      fetch: get,
    }
  }

  // Whole segments, newest last; a read that comes back for one finds it here.
  const kept = new Map<number, Promise<Uint8Array>>()
  const wholeSegment = (index: number): Promise<Uint8Array> => {
    const hit = kept.get(index)
    if (hit) {
      kept.delete(index)
      kept.set(index, hit)
      return hit
    }
    const segment = segments[index]
    const read = rangeBytes(reading(index, segment.size), 0, segment.size)
    read.catch(() => { if (kept.get(index) === read) kept.delete(index) })
    kept.set(index, read)
    while (kept.size > WHOLE_SEGMENTS_KEPT) kept.delete(kept.keys().next().value!)
    return read
  }

  const segmentAt = (position: number) => {
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle] <= position) low = middle
      else high = middle - 1
    }
    return low
  }

  type Piece = { index: number; whole: boolean; opts: RangeReaderOptions; from: number; to: number }

  /** The pieces of `[start, end)`, each inside one segment. */
  const pieces = (start: number, end: number) => {
    const out: Piece[] = []
    const stop = Math.min(end, size)
    for (let index = start < stop ? segmentAt(start) : segments.length; index < segments.length && starts[index] < stop; index++) {
      const segment = segments[index]
      const from = Math.max(start, starts[index]) - starts[index]
      const to = Math.min(stop, starts[index] + segment.size) - starts[index]
      out.push({
        index,
        whole: segment.whole,
        opts: reading(index, segment.offset + segment.size),
        from: segment.offset + from,
        to: segment.offset + to,
      })
    }
    return out
  }

  const pieceBytes = async (piece: Piece): Promise<Uint8Array> => piece.whole
    ? (await wholeSegment(piece.index)).subarray(piece.from, piece.to)
    : rangeBytes(piece.opts, piece.from, piece.to)

  const stream = (start: number, end: number): ReadableStream<Uint8Array> => {
    const queue = pieces(start, end)
    let current: ReadableStreamDefaultReader<Uint8Array> | null = null
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          if (!current) {
            const piece = queue.shift()
            if (!piece) { controller.close(); return }
            if (piece.whole) {
              controller.enqueue((await wholeSegment(piece.index)).slice(piece.from, piece.to))
              return
            }
            current = rangeStream(piece.opts, piece.from, piece.to).getReader()
          }
          const { done, value } = await current.read()
          if (done) { current = null; continue }
          controller.enqueue(value)
          return
        }
      },
      cancel() {
        void current?.cancel().catch(() => {})
      },
    })
  }

  return {
    name,
    size,
    durationSeconds: plan.seconds,
    tap,
    read: async (start, end) => {
      const parts = await Promise.all(pieces(start, end).map(pieceBytes))
      const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
      let at = 0
      for (const part of parts) { out.set(part, at); at += part.byteLength }
      return out
    },
    source: () => new CustomSource({
      read: (start, end) => teeInto(tap, start, stream(start, end)),
      getSize: async () => size,
      prefetchProfile: 'network',
      maxCacheSize: REMOTE_CACHE_BYTES,
    }),
    abortReads: () => gate.abort(),
    dispose: () => { kept.clear(); tap.close(); gate.close() },
  }
}
