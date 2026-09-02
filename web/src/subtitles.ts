// Served from public/ rather than imported with `?url`, so the page graph and
// the worker graph share one copy. The version is a cache key, not a path, and
// scripts/sync-parser.mjs keeps it in step with the installed package.
const parserBundleUrl = '/matroska-subtitles.min.js?v=3.3.2'
import { convertAssCue, parseAssHeader, positionDialogueCues, type AssTrackInfo } from './assvtt'
import { buildAssDocument, isFontAttachment } from './assDoc'
import type { VttTrack } from './subtitleFormats'

export const MAX_SUBTITLE_TRACKS = 64
const PUBLISH_INTERVAL_MS = 8_000

export interface SubtitleCue {
  text: string
  time: number
  duration: number
  style?: string
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
  ass: AssTrackInfo | null
  rawHeader: string | null
}

// The browser bundle of matroska-subtitles is loaded as a global: its ESM
// build relies on Node builtins and cannot be bundled by Vite.
interface MatroskaTrackInfo {
  number: number
  language?: string
  name?: string
  type: string
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
  if (typeof document === 'undefined') {
    parserBundlePromise ??= fetch(parserBundleUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`failed to load matroska-subtitles bundle (${response.status})`)
        return response.text()
      })
      .then((code) => {
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
 * An incremental extractor: cues live in the clusters interleaved with the
 * video, so what has been read so far is usable before the last byte arrives.
 */
export interface MatroskaSubtitleStream {
  write(chunk: Uint8Array): void
  snapshot(): VttTrack[]
  /** Ends the parser and resolves with the tracks that carry cues. */
  finish(): Promise<VttTrack[]>
  /** Complete only once the parser has read past the attachments element. */
  fonts(): AttachedFont[]
}

export interface AttachedFont {
  filename: string
  data: Uint8Array
}

const MAX_FONT_BYTES = 8 * 1024 * 1024
const MAX_FONTS = 24

export async function createMatroskaSubtitleStream(): Promise<MatroskaSubtitleStream> {
  const { SubtitleParser } = await loadParserBundle()
  const parser = new SubtitleParser()
  const tracks = new Map<number, ExtractedTrack>()
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
  parser.resume()

  const collect = (requireCues: boolean): VttTrack[] => order
    .map((number) => tracks.get(number))
    .filter((track): track is ExtractedTrack => track !== undefined && (!requireCues || track.cues.length > 0))
    .map((track) => {
      const out: VttTrack = { language: track.language, title: track.title, vtt: toWebVTT(track.cues, track.ass) }
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

// Rewrites an ASS dialogue line as VTT cue text: italic and bold become
// <i>/<b>, every other override is dropped.
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
 * Merges the subtitle sources of one room — sibling files and muxed tracks,
 * which land at different times — and posts their union. The room counts as
 * complete only once every registered source is done.
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
  const sent = new Map<string, string>()
  const slot = (track: VttTrack, index: number) => `${index}\u0000${track.language}\u0000${track.title}`
  const payloadOf = (track: VttTrack) => `${track.vtt}\u0000${track.ass ?? ''}`

  const register = (source: string) => {
    if (sources.has(source)) return
    sources.set(source, { tracks: [], complete: false })
    order.push(source)
  }

  const union = (): VttTrack[] => order.flatMap((source) => sources.get(source)?.tracks ?? []).slice(0, MAX_SUBTITLE_TRACKS)
  const allComplete = (): boolean => order.every((source) => sources.get(source)?.complete === true)

  const post = async () => {
    dirty = false
    const tracks = union()
    if (tracks.length === 0) return
    const complete = allComplete()
    lastPostAt = Date.now()
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
      if (response.status === 409) return
      if (!response.ok) {
        console.warn(`subtitle upload failed with status ${response.status}`)
        sent.clear()
        return
      }
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
      pending = pending.then(() => (dirty ? post() : Promise.resolve()))
      await pending
    },
  }
}

/**
 * Each font goes up once, raw. Failures are logged and skipped: fonts degrade
 * to the renderer's fallback face and never block the media.
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
