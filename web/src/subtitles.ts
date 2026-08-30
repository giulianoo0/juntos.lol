// Served from public/ rather than imported with `?url`: this module is
// reachable from both the page graph and the worker graph, and each graph
// emitted its own copy of the same 147 kB file under its own name — two
// downloads, two cache entries, for one parser. The copy is refreshed by
// postinstall, so a version bump cannot leave it behind.
// The version is a cache key, not a path: the edge caches this URL for hours,
// and a copy that changed under the same address would be served stale. It is
// kept in step by scripts/sync-parser.mjs, which fails the install if the
// package it copies no longer matches.
const parserBundleUrl = '/matroska-subtitles.min.js?v=3.3.2'
import { convertAssCue, parseAssHeader, positionDialogueCues, type AssTrackInfo } from './assvtt'
import { buildAssDocument, isFontAttachment } from './assDoc'
import type { VttTrack } from './subtitleFormats'

// What the server stores per room (maxSubtitleTracks on its side).
export const MAX_SUBTITLE_TRACKS = 64
// Minimum gap between progressive publishes. Cues keep arriving for as long as
// the source streams, and each publish rewrites every track server-side.
const PUBLISH_INTERVAL_MS = 8_000

export interface SubtitleCue {
  text: string
  time: number
  duration: number
  /** ASS style name, present on cues of ass/ssa tracks. */
  style?: string
  /** The remaining ASS dialogue fields the container carries per cue. */
  layer?: string
  name?: string
  marginL?: string
  marginR?: string
  marginV?: string
  effect?: string
}

interface ExtractedTrack {
  number: number
  language: string
  title: string
  cues: SubtitleCue[]
  /** Parsed ASS header for ass/ssa tracks, null for plain-text ones. */
  ass: AssTrackInfo | null
  /** The raw CodecPrivate of an ass/ssa track — the document's own head. */
  rawHeader: string | null
}

// Types for the self-contained browser bundle of matroska-subtitles, which is
// loaded via a <script> tag and exposed as a global (its ESM build relies on
// Node builtins and cannot be bundled by Vite).
interface MatroskaTrackInfo {
  number: number
  language?: string
  name?: string
  type: string
  /** The track's CodecPrivate: for ass/ssa, the script info and style table. */
  header?: string
}

interface MatroskaAttachment {
  filename?: string
  mimetype?: string
  data?: Uint8Array
}

interface MatroskaSubtitleParser {
  once(event: 'tracks', listener: (tracks: MatroskaTrackInfo[]) => void): void
  on(event: 'subtitle', listener: (subtitle: SubtitleCue, trackNumber: number) => void): void
  on(event: 'file', listener: (file: MatroskaAttachment) => void): void
  on(event: 'finish' | 'error', listener: (error?: unknown) => void): void
  resume(): void
  write(chunk: Uint8Array): void
  end(): void
}

interface MatroskaSubtitlesGlobal {
  SubtitleParser: new () => MatroskaSubtitleParser
}

declare global {
  var MatroskaSubtitles: MatroskaSubtitlesGlobal | undefined
}

let parserBundlePromise: Promise<MatroskaSubtitlesGlobal> | null = null

function loadParserBundle(): Promise<MatroskaSubtitlesGlobal> {
  if (globalThis.MatroskaSubtitles) return Promise.resolve(globalThis.MatroskaSubtitles)
  // A worker has no document to hang a script tag on, and importing the UMD
  // bundle as a module would trap its `var` in module scope. Indirect eval
  // runs it in the worker's global scope, where it lands on globalThis.
  if (typeof document === 'undefined') {
    parserBundlePromise ??= fetch(parserBundleUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`failed to load matroska-subtitles bundle (${response.status})`)
        return response.text()
      })
      .then((code) => {
        // The bundle reaches for `window` at parse time; a worker calls it
        // globalThis. The alias is scoped to this worker's global.
        ;(globalThis as { window?: unknown }).window ??= globalThis
        ;(0, eval)(code)
        if (!globalThis.MatroskaSubtitles) throw new Error('matroska-subtitles bundle did not initialize')
        return globalThis.MatroskaSubtitles
      })
    return parserBundlePromise
  }
  parserBundlePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = parserBundleUrl
    script.onload = () => {
      if (globalThis.MatroskaSubtitles) resolve(globalThis.MatroskaSubtitles)
      else reject(new Error('matroska-subtitles bundle did not initialize'))
    }
    script.onerror = () => reject(new Error('failed to load matroska-subtitles bundle'))
    document.head.appendChild(script)
  })
  return parserBundlePromise
}

export function isMatroska(file: { name: string; type?: string }): boolean {
  return file.name.toLowerCase().endsWith('.mkv') || file.type === 'video/x-matroska'
}

/**
 * An incremental Matroska subtitle extractor.
 *
 * Cues live in the clusters interleaved with the video, so a complete track is
 * only known once the last byte has been read. Consuming the stream as it
 * arrives makes the cues seen so far usable immediately, which is what lets a
 * torrent show subtitles long before the download finishes.
 */
export interface MatroskaSubtitleStream {
  write(chunk: Uint8Array): void
  /** Tracks parsed so far, in the container's own order. */
  snapshot(): VttTrack[]
  /** Ends the parser and resolves with the tracks that carry cues. */
  finish(): Promise<VttTrack[]>
  /** Font attachments seen so far. Complete only once the parser has read
   * past the attachments element, which sits near the head of most files. */
  fonts(): AttachedFont[]
}

/** One font file muxed into the container for its ASS tracks. */
export interface AttachedFont {
  filename: string
  data: Uint8Array
}

// Ceilings for what a room will carry to viewers: fonts are megabytes, and a
// release with dozens of them must not turn the subtitle path into a second
// video upload.
const MAX_FONT_BYTES = 8 * 1024 * 1024
const MAX_FONTS = 24

export async function createMatroskaSubtitleStream(): Promise<MatroskaSubtitleStream> {
  const { SubtitleParser } = await loadParserBundle()
  const parser = new SubtitleParser()
  const tracks = new Map<number, ExtractedTrack>()
  // The header order is fixed once the tracks event fires, so publishing in
  // this order keeps a track at the same position across progressive updates.
  const order: number[] = []

  const finished = new Promise<void>((resolve, reject) => {
    parser.on('finish', () => resolve())
    parser.on('error', reject)
  })
  parser.once('tracks', (list) => {
    for (const track of list) {
      if (tracks.has(track.number)) continue
      const styled = track.type === 'ass' || track.type === 'ssa'
      tracks.set(track.number, {
        number: track.number,
        language: track.language ?? 'und',
        title: track.name ?? '',
        cues: [],
        ass: styled && track.header ? parseAssHeader(track.header) : null,
        rawHeader: styled ? track.header ?? null : null,
      })
      order.push(track.number)
    }
  })
  parser.on('subtitle', (subtitle, trackNumber) => tracks.get(trackNumber)?.cues.push(subtitle))
  const fonts: AttachedFont[] = []
  let fontBytes = 0
  parser.on('file', (file) => {
    const data = file.data
    if (!data || !isFontAttachment(file)) return
    if (fonts.length >= MAX_FONTS || data.byteLength > MAX_FONT_BYTES) return
    if (fontBytes + data.byteLength > MAX_FONTS * MAX_FONT_BYTES) return
    fontBytes += data.byteLength
    fonts.push({ filename: file.filename ?? `font_${fonts.length}`, data })
  })
  // The parser is a Transform stream: drain its readable side so the internal
  // buffer never fills up while we feed it the source.
  parser.resume()

  const collect = (requireCues: boolean): VttTrack[] => order
    .map((number) => tracks.get(number))
    .filter((track): track is ExtractedTrack => track !== undefined && (!requireCues || track.cues.length > 0))
    .map((track) => {
      const out: VttTrack = { language: track.language, title: track.title, vtt: toWebVTT(track.cues, track.ass) }
      // Styled tracks also travel as the full document, rebuilt from the
      // container's own header and dialogue fields, so the renderer gets
      // everything the author wrote instead of the VTT approximation.
      if (track.rawHeader !== null) out.ass = buildAssDocument(track.rawHeader, track.cues)
      return out
    })

  return {
    write: (chunk) => parser.write(chunk),
    snapshot: () => collect(false),
    finish: async () => {
      parser.end()
      await finished
      return collect(true)
    },
    fonts: () => [...fonts],
  }
}

export function toWebVTT(cues: SubtitleCue[], ass: AssTrackInfo | null = null): string {
  const sorted = [...cues].sort((a, b) => a.time - b.time)
  const lines = ['WEBVTT', '']
  for (const cue of sorted) {
    const converted = ass
      ? convertAssCue(ass, cue.style, cue.text)
      : { settings: '', text: cleanCueText(cue.text) }
    // A cue with nothing renderable left — a vector drawing, a bare override —
    // would show viewers an empty box.
    if (converted.text === '') continue
    const settings = converted.settings === '' ? '' : ` ${converted.settings}`
    lines.push(`${formatVttTime(cue.time)} --> ${formatVttTime(cue.time + cue.duration)}${settings}`, converted.text, '')
  }
  return positionDialogueCues(lines.join('\n'))
}

function formatVttTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const hours = Math.floor(clamped / 3_600_000)
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000
  const pad2 = (value: number) => String(value).padStart(2, '0')
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${String(millis).padStart(3, '0')}`
}

// cleanCueText rewrites an ASS dialogue line as VTT cue text. Italic and bold
// overrides become the <i>/<b> tags WebVTT can carry — the same mapping the
// server-side ffmpeg extraction produces — and every other override (colors,
// positioning, karaoke) has no VTT equivalent and is dropped.
function cleanCueText(text: string): string {
  const open: Array<'i' | 'b'> = []
  const active = { i: false, b: false }
  let out = ''
  let last = 0
  for (const block of text.matchAll(/\{([^}]*)\}/g)) {
    out += text.slice(last, block.index)
    last = block.index + block[0].length
    for (const flag of block[1].matchAll(/\\(i|b)(\d+)/g)) {
      const style = flag[1] as 'i' | 'b'
      const on = flag[2] !== '0'
      if (on === active[style]) continue
      active[style] = on
      if (on) {
        open.push(style)
        out += `<${style}>`
        continue
      }
      // VTT ignores an end tag that is not the innermost one, so closing a
      // style closes everything above it and reopens what should survive.
      const depth = open.lastIndexOf(style)
      for (let index = open.length - 1; index >= depth; index -= 1) out += `</${open[index]}>`
      for (const kept of open.splice(depth).slice(1)) {
        open.push(kept)
        out += `<${kept}>`
      }
    }
  }
  out += text.slice(last)
  for (let index = open.length - 1; index >= 0; index -= 1) out += `</${open[index]}>`
  return out
    .replace(/\\N/g, '\n')
    .trim()
}

/**
 * Merges the subtitle sources of one room into a single publication.
 *
 * A torrent can offer both sibling subtitle files and tracks muxed into the
 * video. They land at very different times, so each source publishes on its
 * own and the collector posts the union. The room is only reported complete
 * once every registered source is done, which is what keeps the authoritative
 * server-side extraction scheduled while an extraction is still partial.
 */
export interface SubtitleCollector {
  register(source: string): void
  publish(source: string, tracks: VttTrack[], complete: boolean): void
  /** Posts any pending update and waits for it to land. */
  flush(): Promise<void>
}

interface CollectorSource {
  tracks: VttTrack[]
  complete: boolean
}

export function createSubtitleCollector(roomID: string, mediaGeneration: number): SubtitleCollector {
  const sources = new Map<string, CollectorSource>()
  const order: string[] = []
  let pending: Promise<void> = Promise.resolve()
  let lastPostAt = 0
  let dirty = false
  // The text of each track as the server last accepted it. Keyed by position
  // *and* name, because position alone is not an identity: a sibling .srt
  // finishing its read pushes every embedded track one slot along, and a
  // track that inherits a neighbour's slot must send its bytes rather than
  // let the server keep the previous occupant's file under that index.
  const sent = new Map<string, string>()
  const slot = (track: VttTrack, index: number) => `${index}\u0000${track.language}\u0000${track.title}`
  // What identifies a track's bytes: the VTT and the ASS travel and change
  // together, so one record covers both.
  const payloadOf = (track: VttTrack) => `${track.vtt}\u0000${track.ass ?? ''}`

  const register = (source: string) => {
    if (sources.has(source)) return
    sources.set(source, { tracks: [], complete: false })
    order.push(source)
  }

  // The server refuses a post with more tracks than it will store, rather
  // than keeping some: a release with more is cut here, embedded first.
  const union = (): VttTrack[] => order.flatMap((source) => sources.get(source)?.tracks ?? []).slice(0, MAX_SUBTITLE_TRACKS)
  const allComplete = (): boolean => order.every((source) => sources.get(source)?.complete === true)

  const post = async () => {
    dirty = false
    const tracks = union()
    if (tracks.length === 0) return
    const complete = allComplete()
    lastPostAt = Date.now()
    // A pass over a big file republishes every few seconds, and most of what
    // it sends is tracks that finished long ago — on the same uplink the
    // remux is pushing segments up. A track whose text the server already has
    // travels as its name alone; the position in the list is what identifies
    // it, on both sides.
    const body = tracks.map((track, index) => (
      sent.get(slot(track, index)) === payloadOf(track)
        ? { language: track.language, title: track.title }
        : track
    ))
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: body, complete, mediaGeneration }),
      })
      // 409 means the room moved on to another video while this extraction
      // was still reading the previous one. Nothing to retry: these cues
      // describe a source nobody is watching any more.
      if (response.status === 409) return
      if (!response.ok) {
        console.warn(`subtitle upload failed with status ${response.status}`)
        // The server and this map no longer agree on what it holds; the next
        // post sends everything rather than guessing which half stuck.
        sent.clear()
        return
      }
      // Only what the server acknowledged may be left out of the next post.
      sent.clear()
      tracks.forEach((track, index) => sent.set(slot(track, index), payloadOf(track)))
    } catch (error) {
      console.error('subtitle upload failed', error)
    }
  }

  const schedule = (immediate: boolean) => {
    dirty = true
    if (!immediate && Date.now() - lastPostAt < PUBLISH_INTERVAL_MS) return
    pending = pending.then(() => (dirty ? post() : Promise.resolve()))
  }

  return {
    register,
    publish: (source, tracks, complete) => {
      register(source)
      sources.set(source, { tracks, complete })
      schedule(complete)
    },
    flush: async () => {
      // Re-check when the link runs, not when it is queued: a publish that
      // already scheduled a post clears the flag before this link is reached,
      // and an unconditional post here would duplicate it.
      pending = pending.then(() => (dirty ? post() : Promise.resolve()))
      await pending
    },
  }
}

/**
 * Sends the fonts a container carries for its ASS tracks. Each font goes up
 * once, raw, and the server records it on the room so every viewer's
 * renderer can load the exact faces the subtitles were authored against.
 * Failures are logged and skipped: fonts degrade to the renderer's fallback
 * face, never block the media.
 */
export async function postSubtitleFonts(
  roomID: string,
  mediaGeneration: number,
  fonts: AttachedFont[],
  alreadySent: Set<string>,
): Promise<void> {
  for (const font of fonts) {
    const key = `${font.filename}:${font.data.byteLength}`
    if (alreadySent.has(key)) continue
    alreadySent.add(key)
    try {
      const query = `name=${encodeURIComponent(font.filename)}&mediaGeneration=${mediaGeneration}`
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/subtitles/fonts?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: font.data as unknown as BodyInit,
      })
      // 409 is a source swap; nothing later will want these fonts either.
      if (response.status === 409) return
      if (!response.ok) {
        console.warn(`subtitle font upload failed with status ${response.status}`, font.filename)
        alreadySent.delete(key)
      }
    } catch (error) {
      console.warn('subtitle font upload failed', font.filename, error)
      alreadySent.delete(key)
    }
  }
}
