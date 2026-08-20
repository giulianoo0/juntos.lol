import parserBundleUrl from 'matroska-subtitles/dist/matroska-subtitles.min.js?url'
import { convertAssCue, parseAssHeader, type AssTrackInfo } from './assvtt'
import type { VttTrack } from './subtitleFormats'

const SLICE_BYTES = 8 * 1024 * 1024
// Minimum gap between progressive publishes. Cues keep arriving for as long as
// the source streams, and each publish rewrites every track server-side.
const PUBLISH_INTERVAL_MS = 8_000

export interface SubtitleCue {
  text: string
  time: number
  duration: number
  /** ASS style name, present on cues of ass/ssa tracks. */
  style?: string
}

interface ExtractedTrack {
  number: number
  language: string
  title: string
  cues: SubtitleCue[]
  /** Parsed ASS header for ass/ssa tracks, null for plain-text ones. */
  ass: AssTrackInfo | null
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

interface MatroskaSubtitleParser {
  once(event: 'tracks', listener: (tracks: MatroskaTrackInfo[]) => void): void
  on(event: 'subtitle', listener: (subtitle: SubtitleCue, trackNumber: number) => void): void
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
}

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
      })
      order.push(track.number)
    }
  })
  parser.on('subtitle', (subtitle, trackNumber) => tracks.get(trackNumber)?.cues.push(subtitle))
  // The parser is a Transform stream: drain its readable side so the internal
  // buffer never fills up while we feed it the source.
  parser.resume()

  const collect = (requireCues: boolean): VttTrack[] => order
    .map((number) => tracks.get(number))
    .filter((track): track is ExtractedTrack => track !== undefined && (!requireCues || track.cues.length > 0))
    .map((track) => ({ language: track.language, title: track.title, vtt: toWebVTT(track.cues, track.ass) }))

  return {
    write: (chunk) => parser.write(chunk),
    snapshot: () => collect(false),
    finish: async () => {
      parser.end()
      await finished
      return collect(true)
    },
  }
}

// Streams a whole file through the parser in slices, so memory stays bounded
// even for multi-GB uploads.
async function extractSubtitleTracks(file: File): Promise<VttTrack[]> {
  const stream = await createMatroskaSubtitleStream()
  for (let offset = 0; offset < file.size; offset += SLICE_BYTES) {
    stream.write(new Uint8Array(await file.slice(offset, offset + SLICE_BYTES).arrayBuffer()))
  }
  return await stream.finish()
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
  return lines.join('\n')
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

  const register = (source: string) => {
    if (sources.has(source)) return
    sources.set(source, { tracks: [], complete: false })
    order.push(source)
  }

  const union = (): VttTrack[] => order.flatMap((source) => sources.get(source)?.tracks ?? [])
  const allComplete = (): boolean => order.every((source) => sources.get(source)?.complete === true)

  const post = async () => {
    dirty = false
    const tracks = union()
    if (tracks.length === 0) return
    const complete = allComplete()
    lastPostAt = Date.now()
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks, complete, mediaGeneration }),
      })
      // 409 means the room moved on to another video while this extraction
      // was still reading the previous one. Nothing to retry: these cues
      // describe a source nobody is watching any more.
      if (response.status === 409) return
      if (!response.ok) console.warn(`subtitle upload failed with status ${response.status}`)
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

// Best-effort client-side subtitle extraction for a local file: embedded text
// tracks are posted while the upload is still running. Never rejects; the
// server-side extraction at upload completion remains the fallback.
export async function extractAndUploadSubtitles(file: File, roomID: string,
  mediaGeneration: number): Promise<void> {
  if (!isMatroska(file)) return
  const collector = createSubtitleCollector(roomID, mediaGeneration)
  collector.register('embedded')
  try {
    collector.publish('embedded', await extractSubtitleTracks(file), true)
    await collector.flush()
  } catch (error) {
    console.error('subtitle extraction failed', error)
  }
}
