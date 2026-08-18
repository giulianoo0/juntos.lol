import parserBundleUrl from 'matroska-subtitles/dist/matroska-subtitles.min.js?url'

const SLICE_BYTES = 8 * 1024 * 1024

export interface SubtitleCue {
  text: string
  time: number
  duration: number
}

interface ExtractedTrack {
  language: string
  title: string
  cues: SubtitleCue[]
}

// Types for the self-contained browser bundle of matroska-subtitles, which is
// loaded via a <script> tag and exposed as a global (its ESM build relies on
// Node builtins and cannot be bundled by Vite).
interface MatroskaTrackInfo {
  number: number
  language?: string
  name?: string
  type: string
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

function isMatroska(file: File): boolean {
  return file.name.toLowerCase().endsWith('.mkv') || file.type === 'video/x-matroska'
}

// Streams the file through the EBML parser in slices, so memory stays bounded
// even for multi-GB uploads.
async function extractSubtitleTracks(file: File): Promise<ExtractedTrack[]> {
  const { SubtitleParser } = await loadParserBundle()
  return new Promise((resolve, reject) => {
    const parser = new SubtitleParser()
    const tracks = new Map<number, ExtractedTrack>()
    parser.once('tracks', (list) => {
      for (const track of list) {
        tracks.set(track.number, { language: track.language ?? 'und', title: track.name ?? '', cues: [] })
      }
    })
    parser.on('subtitle', (subtitle, trackNumber) => tracks.get(trackNumber)?.cues.push(subtitle))
    parser.on('finish', () => resolve([...tracks.values()]))
    parser.on('error', reject)
    // The parser is a Transform stream: drain its readable side so the
    // internal buffer never fills up while we feed it the whole file.
    parser.resume()
    void (async () => {
      try {
        for (let offset = 0; offset < file.size; offset += SLICE_BYTES) {
          parser.write(new Uint8Array(await file.slice(offset, offset + SLICE_BYTES).arrayBuffer()))
        }
        parser.end()
      } catch (error) {
        reject(error instanceof Error ? error : new Error('subtitle extraction failed'))
      }
    })()
  })
}

export function toWebVTT(cues: SubtitleCue[]): string {
  const sorted = [...cues].sort((a, b) => a.time - b.time)
  const lines = ['WEBVTT', '']
  for (const cue of sorted) {
    lines.push(`${formatVttTime(cue.time)} --> ${formatVttTime(cue.time + cue.duration)}`, cleanCueText(cue.text), '')
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

function cleanCueText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .trim()
}

// Best-effort client-side subtitle extraction: embedded text tracks are
// posted while the upload is still running. Never rejects; the server-side
// extraction at upload completion remains the authoritative fallback.
export async function extractAndUploadSubtitles(file: File, roomID: string): Promise<void> {
  if (!isMatroska(file)) return
  try {
    const extracted = await extractSubtitleTracks(file)
    const tracks = extracted
      .filter((track) => track.cues.length > 0)
      .map((track) => ({ language: track.language, title: track.title, vtt: toWebVTT(track.cues) }))
    if (tracks.length === 0) return
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/subtitles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks }),
    })
    if (!response.ok) console.warn(`subtitle upload failed with status ${response.status}`)
  } catch (error) {
    console.error('subtitle extraction failed', error)
  }
}
