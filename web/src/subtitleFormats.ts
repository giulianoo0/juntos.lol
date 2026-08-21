import { convertAssCue, parseAssHeader, positionDialogueCues } from './assvtt'

// Converters for the subtitle files that ship next to the video inside a
// torrent. Releases commonly carry SubRip or ASS/SSA in a "Subs" folder
// instead of muxing them into the container, and those files are tiny and
// complete on their own, so they never need the whole video to be available.

export interface VttTrack {
  language: string
  title: string
  vtt: string
}

const SUBTITLE_EXTENSION = /\.(srt|ass|ssa|vtt|sub)$/i

// ISO 639-2 is what the mkv tracks use, so external files are normalized to
// the same vocabulary and the player labels both alike.
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

// Two-letter codes that appear in release file names, mapped to the same
// three-letter vocabulary.
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

// Reads the language and a human label out of a file name. Releases label
// subtitles in the name and nowhere else, so this is the only signal there is.
export function subtitleIdentity(path: string): { language: string; title: string } {
  const fileName = path.split('/').pop() ?? path
  const base = fileName.replace(SUBTITLE_EXTENSION, '')
  // Hyphens are kept while a token still looks like a region-qualified tag
  // (pt-BR), and split otherwise, so a hyphenated title still tokenizes.
  const tokens = base.split(/[._\s()[\]]+/).filter(Boolean).flatMap((token) => (
    /^[a-z]{2}-[a-z]{2}$/i.test(token) ? [token] : token.split('-').filter(Boolean)
  ))

  let language = 'und'
  // Later tokens win: "Movie.2019.1080p.eng.srt" names the language last,
  // while an early token is far more likely to be part of the title.
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

// Decodes bytes that claim no encoding. Subtitle files are usually UTF-8 but
// older releases are Windows-1252; a replacement character means the strict
// UTF-8 pass failed, so fall back rather than render mojibake.
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

// Converts one subtitle file to WebVTT, or returns null when the format is
// unsupported (bitmap VobSub .sub) or the file holds no usable cue.
export function convertSubtitleFile(path: string, data: ArrayBuffer): VttTrack | null {
  const text = decodeSubtitleText(data)
  const extension = (path.split('.').pop() ?? '').toLowerCase()
  let vtt: string | null = null
  if (extension === 'vtt') vtt = normalizeWebVTT(text)
  else if (extension === 'ass' || extension === 'ssa') vtt = assToWebVTT(text)
  else if (extension === 'srt') vtt = srtToWebVTT(text)
  else if (extension === 'sub') vtt = text.includes('-->') ? srtToWebVTT(text) : null
  if (!vtt) return null
  return { ...subtitleIdentity(path), vtt: positionDialogueCues(vtt) }
}

function normalizeWebVTT(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n/, '').trim()
  if (!body.includes('-->')) return ''
  return `WEBVTT\n\n${body}\n`
}

// SubRip differs from WebVTT in the decimal separator and the numeric cue
// counters, which WebVTT accepts as cue identifiers.
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
    // A lone number opening a cue block is the SubRip counter. Keeping it
    // would render as a cue identifier, which is harmless, but dropping it
    // keeps the output comparable to the muxed tracks. The first cue has no
    // preceding blank line, so an empty output counts as a block boundary too.
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

// Converts an ASS/SSA script. Placement, italics, bold and quantized colors
// survive as WebVTT cue settings and tags; the styling VTT cannot carry is
// dropped.
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

    // Without a Format line the script is malformed; assume the standard order.
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

// The Text field is last and may itself contain commas, so only the leading
// fields are split off.
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
  // ASS centiseconds are two digits; WebVTT wants milliseconds.
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}.${fraction.padEnd(3, '0').slice(0, 3)}`
}

