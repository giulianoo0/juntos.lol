// Rebuilds a complete ASS document from what a Matroska container stores:
// the track's CodecPrivate (script info, styles, and usually the [Events]
// Format line) plus the per-cue dialogue fields the demuxer hands over. The
// result is byte-faithful enough for libass to render everything the author
// wrote — karaoke, borders, blur, rotation, vector drawings — which the VTT
// conversion by design cannot carry.

export interface AssCueFields {
  layer?: string
  style?: string
  name?: string
  marginL?: string
  marginR?: string
  marginV?: string
  effect?: string
}

export interface AssDocCue extends AssCueFields {
  text: string
  time: number
  duration: number
}

const EVENTS_FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'

/** ASS timestamps are H:MM:SS.cc — centiseconds, single-digit hours. */
export function formatAssTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms / 10))
  const cs = clamped % 100
  const totalSeconds = Math.floor(clamped / 100)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad2 = (v: number) => String(v).padStart(2, '0')
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(cs)}`
}

// A field that will be joined by commas must not carry one of its own, or
// every field after it shifts. Only the free-text fields can; text itself is
// last and may hold commas freely.
function safeField(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim()
  if (v === '') return fallback
  return v.replaceAll(',', ';').replace(/[\r\n]/g, ' ')
}

function numField(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim()
  return /^-?\d+$/.test(v) ? v : fallback
}

/** Header verbatim, then one Dialogue line per cue in playback order. */
export function buildAssDocument(header: string, cues: AssDocCue[]): string {
  let head = header.replace(/\r\n?/g, '\n').trimEnd()
  if (head === '') {
    head = '[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288'
  }
  const hasEvents = /^\s*\[events\]\s*$/im.test(head)
  const lines = [head]
  if (!hasEvents) {
    lines.push('', '[Events]', EVENTS_FORMAT)
  } else if (!/^\s*format\s*:/im.test(head.slice(head.toLowerCase().lastIndexOf('[events]')))) {
    lines.push(EVENTS_FORMAT)
  }

  const sorted = [...cues].sort((a, b) => a.time - b.time)
  for (const cue of sorted) {
    const text = cue.text.replace(/[\r\n]/g, ' ').trim()
    if (text === '') continue
    lines.push(
      'Dialogue: '
      + `${numField(cue.layer, '0')},`
      + `${formatAssTime(cue.time)},${formatAssTime(cue.time + cue.duration)},`
      + `${safeField(cue.style, 'Default')},`
      + `${safeField(cue.name, '')},`
      + `${numField(cue.marginL, '0')},${numField(cue.marginR, '0')},${numField(cue.marginV, '0')},`
      + `${safeField(cue.effect, '')},`
      + text,
    )
  }
  return `${lines.join('\n')}\n`
}

const FONT_MIMES = new Set([
  'font/ttf', 'font/otf', 'font/sfnt', 'font/woff', 'font/woff2', 'font/collection',
  'application/x-truetype-font', 'application/x-font-ttf', 'application/x-font-otf',
  'application/vnd.ms-opentype', 'application/font-sfnt', 'application/x-font',
])

const FONT_EXTENSIONS = /\.(ttf|otf|ttc|woff2?)$/i

export function isFontAttachment(file: { filename?: string; mimetype?: string }): boolean {
  const mime = (file.mimetype ?? '').toLowerCase().split(';')[0].trim()
  if (FONT_MIMES.has(mime)) return true
  return FONT_EXTENSIONS.test(file.filename ?? '')
}
