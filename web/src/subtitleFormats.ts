import { convertAssCue, parseAssHeader, positionDialogueCues } from './assvtt'

// Converters for the subtitle files that ship next to the video inside a
// torrent. Releases commonly carry SubRip or ASS/SSA in a "Subs" folder
// instead of muxing them into the container, and those files are tiny and
// complete on their own, so they never need the whole video to be available.

export interface VttTrack {
  language: string
  title: string
  vtt: string
  ass?: string
}

const SUBTITLE_EXTENSION = /\.(srt|ass|ssa|vtt|sub)$/i

// ISO 639-2, the same vocabulary the mkv tracks use.
const LANGUAGE_NAMES: Record<string, string> = {
  arabic: 'ara',
  chinese: 'chi',
  croatian: 'hrv',
  czech: 'cze',
  danish: 'dan',
  dutch: 'dut',
  english: 'eng',
  finnish: 'fin',
  french: 'fre',
  german: 'ger',
  greek: 'gre',
  hebrew: 'heb',
  hindi: 'hin',
  hungarian: 'hun',
  indonesian: 'ind',
  italian: 'ita',
  japanese: 'jpn',
  korean: 'kor',
  norwegian: 'nor',
  polish: 'pol',
  portuguese: 'por',
  romanian: 'rum',
  russian: 'rus',
  serbian: 'srp',
  spanish: 'spa',
  swedish: 'swe',
  thai: 'tha',
  turkish: 'tur',
  ukrainian: 'ukr',
  vietnamese: 'vie',
}

const LANGUAGE_CODES = new Set(Object.values(LANGUAGE_NAMES))

const SHORT_CODES: Record<string, string> = {
  ar: 'ara', cs: 'cze', da: 'dan', de: 'ger', el: 'gre', en: 'eng', es: 'spa',
  fi: 'fin', fr: 'fre', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', id: 'ind',
  it: 'ita', ja: 'jpn', ko: 'kor', nl: 'dut', no: 'nor', pl: 'pol', pt: 'por',
  ro: 'rum', ru: 'rus', sr: 'srp', sv: 'swe', th: 'tha', tr: 'tur', uk: 'ukr',
  vi: 'vie', zh: 'chi',
}

export function isSubtitleFileName(name: string): boolean {
  return SUBTITLE_EXTENSION.test(name)
}

export function subtitleIdentity(path: string): { language: string; title: string } {
  const fileName = path.split('/').pop() ?? path
  const base = fileName.replace(SUBTITLE_EXTENSION, '')
  const tokens = base.split(/[._\s()[\]]+/).filter(Boolean).flatMap((token) => (
    /^[a-z]{2}-[a-z]{2}$/i.test(token) ? [token] : token.split('-').filter(Boolean)
  ))

  let language = 'und'
  // Later tokens win: an early one is far more likely part of the title.
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (LANGUAGE_NAMES[lower]) language = LANGUAGE_NAMES[lower]
    else if (LANGUAGE_CODES.has(lower)) language = lower
    else if (SHORT_CODES[lower]) language = SHORT_CODES[lower]
    else if (/^[a-z]{2}-[a-z]{2}$/i.test(token)) language = token.toLowerCase()
  }

  const title = base.replace(/[._]+/g, ' ').trim().slice(0, 120)
  return { language, title: title || 'Subtitle' }
}

// UTF-8, falling back to Windows-1252 when the strict pass fails.
export function decodeSubtitleText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  try {
    return stripBOM(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return stripBOM(new TextDecoder('windows-1252').decode(bytes))
  }
}

function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// Null when the format is unsupported (bitmap VobSub .sub) or holds no cue.
export function convertSubtitleFile(path: string, data: ArrayBuffer): VttTrack | null {
  const text = decodeSubtitleText(data)
  const extension = (path.split('.').pop() ?? '').toLowerCase()
  let vtt: string | null = null
  if (extension === 'vtt') vtt = normalizeWebVTT(text)
  else if (extension === 'ass' || extension === 'ssa') vtt = assToWebVTT(text)
  else if (extension === 'srt') vtt = srtToWebVTT(text)
  else if (extension === 'sub') vtt = text.includes('-->') ? srtToWebVTT(text) : null
  if (!vtt) return null
  const track: VttTrack = { ...subtitleIdentity(path), vtt: positionDialogueCues(vtt) }
  if (extension === 'ass' || extension === 'ssa') track.ass = normalizeAssSidecar(text)
  return track
}

function normalizeWebVTT(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n/, '').trim()
  if (!body.includes('-->')) return ''
  return `WEBVTT\n\n${body}\n`
}

export function srtToWebVTT(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let cues = 0
  for (const line of lines) {
    const timing = parseSrtTiming(line)
    if (timing) {
      cues += 1
      output.push(timing)
      continue
    }
    // A lone number opening a cue block is the SubRip counter, dropped so the
    // output matches the muxed tracks.
    if (/^\d+$/.test(line.trim()) && (output.length === 0 || output[output.length - 1] === '')) continue
    output.push(line)
  }
  if (cues === 0) return ''
  return `WEBVTT\n\n${output.join('\n').trim()}\n`
}

function parseSrtTiming(line: string): string | null {
  const match = /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(line)
  if (!match) return null
  return `${normalizeSrtStamp(match[1])} --> ${normalizeSrtStamp(match[2])}`
}

function normalizeSrtStamp(stamp: string): string {
  const [clock, fraction = '0'] = stamp.replace(',', '.').split('.')
  const [hours, minutes, seconds] = clock.split(':')
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}`
}

// The server validates ASS by its leading section header, so anything before
// [Script Info] is trimmed; a file without one is left for it to refuse.
function normalizeAssSidecar(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const at = normalized.search(/^\[script info\]/im)
  return at > 0 ? normalized.slice(at) : normalized
}

export function assToWebVTT(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const info = parseAssHeader(normalized)
  let fields: string[] | null = null
  let inEvents = false
  const cues: string[] = []

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(trimmed)
      continue
    }
    if (!inEvents) continue
    if (/^format\s*:/i.test(trimmed)) {
      fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase())
      continue
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue

    const order = fields ?? ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    const values = splitAssFields(trimmed.slice(trimmed.indexOf(':') + 1), order.length)
    const start = values[order.indexOf('start')]
    const end = values[order.indexOf('end')]
    const converted = convertAssCue(info, values[order.indexOf('style')], values[order.indexOf('text')] ?? '')
    if (!start || !end || !converted.text) continue
    const settings = converted.settings === '' ? '' : ` ${converted.settings}`
    cues.push(`${normalizeAssStamp(start)} --> ${normalizeAssStamp(end)}${settings}\n${converted.text}\n`)
  }

  if (cues.length === 0) return ''
  return `WEBVTT\n\n${cues.join('\n')}`
}

// The Text field is last and may contain commas, so only the leading fields
// are split off.
function splitAssFields(value: string, count: number): string[] {
  const parts: string[] = []
  let rest = value
  for (let index = 0; index < count - 1; index += 1) {
    const comma = rest.indexOf(',')
    if (comma < 0) break
    parts.push(rest.slice(0, comma).trim())
    rest = rest.slice(comma + 1)
  }
  parts.push(rest)
  return parts
}

function normalizeAssStamp(stamp: string): string {
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(stamp.trim())
  if (!match) return '00:00:00.000'
  const [, hours, minutes, seconds, fraction = '0'] = match
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}.${fraction.padEnd(3, '0').slice(0, 3)}`
}

