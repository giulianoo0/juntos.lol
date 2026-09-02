// ASS carries styling WebVTT has no vocabulary for. What does map is
// converted here: alignment and \pos become cue settings, italics and bold
// become <i>/<b>, and colors snap to the standard VTT color classes that
// every renderer styles natively. The rest — karaoke, borders, blur,
// rotation, vector drawings — is dropped.
//
// The server-side Go converter (internal/media/assvtt.go) implements the same
// mapping, so the authoritative pass replaces these files without visibly
// restyling anything.

export interface AssStyleInfo {
  italic: boolean
  bold: boolean
  color: string | null
  alignment: number
}

export interface AssTrackInfo {
  playResX: number
  playResY: number
  styles: Map<string, AssStyleInfo>
}

export interface ConvertedCue {
  settings: string
  text: string
}

const DEFAULT_STYLE: AssStyleInfo = { italic: false, bold: false, color: null, alignment: 2 }

const VTT_COLORS = [
  { name: 'white', r: 255, g: 255, b: 255 },
  { name: 'yellow', r: 255, g: 255, b: 0 },
  { name: 'cyan', r: 0, g: 255, b: 255 },
  { name: 'red', r: 255, g: 0, b: 0 },
  { name: 'lime', r: 0, g: 255, b: 0 },
  { name: 'magenta', r: 255, g: 0, b: 255 },
  { name: 'blue', r: 0, g: 0, b: 255 },
  { name: 'black', r: 0, g: 0, b: 0 },
]

// Lookaheads keep short names from swallowing longer ones: \b must not match
// \bord, \c must not match \clip, \p must not match \pos.
const OVERRIDE_TAG = /\\(pos|move|an|a(?=-?\d)|1?c(?=&|\\|$)|i(?=-?\d)|b(?=-?\d)|p(?=-?\d)|r)([^\\]*)/g

export function parseAssHeader(header: string): AssTrackInfo {
  const info: AssTrackInfo = { playResX: 384, playResY: 288, styles: new Map() }
  let fields: string[] | null = null
  let section = ''
  let legacy = false
  for (const raw of header.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      section = line.toLowerCase()
      legacy = section === '[v4 styles]'
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (section === '[script info]') {
      if (key === 'playresx') info.playResX = positiveNumber(value, info.playResX)
      if (key === 'playresy') info.playResY = positiveNumber(value, info.playResY)
      continue
    }
    if (!section.endsWith('styles]')) continue
    if (key === 'format') {
      fields = value.split(',').map((field) => field.trim().toLowerCase())
      continue
    }
    if (key !== 'style' || !fields) continue
    const values = value.split(',')
    const columns = fields
    const field = (name: string) => {
      const index = columns.indexOf(name)
      return index >= 0 && index < values.length ? values[index].trim() : ''
    }
    const alignment = Number.parseInt(field('alignment'), 10)
    info.styles.set(field('name'), {
      italic: assFlag(field('italic')),
      bold: assFlag(field('bold')),
      color: colorClass(parseAssColor(field('primarycolour'))),
      alignment: Number.isNaN(alignment) ? 2 : normalizeAlignment(alignment, legacy),
    })
  }
  return info
}

export function convertAssCue(info: AssTrackInfo, styleName: string | undefined, raw: string): ConvertedCue {
  const style = (styleName !== undefined && info.styles.get(styleName)) || DEFAULT_STYLE

  let alignment = style.alignment
  let pos: { x: number; y: number } | null = null
  let drawing = false
  const desired = { i: style.italic, b: style.bold, c: style.color }
  const open: Array<'i' | 'b' | 'c'> = []
  let openColor: string | null = null
  let out = ''

  const reconcile = () => {
    let keep = open.length
    for (let index = 0; index < open.length; index += 1) {
      const kind = open[index]
      const wanted = kind === 'c' ? desired.c === openColor : desired[kind]
      if (!wanted) {
        keep = index
        break
      }
    }
    for (let index = open.length - 1; index >= keep; index -= 1) {
      out += `</${open[index] === 'c' ? 'c' : open[index]}>`
    }
    open.length = keep
    if (!open.includes('c')) openColor = null
    if (desired.i && !open.includes('i')) {
      open.push('i')
      out += '<i>'
    }
    if (desired.b && !open.includes('b')) {
      open.push('b')
      out += '<b>'
    }
    if (desired.c !== null && openColor !== desired.c) {
      open.push('c')
      openColor = desired.c
      out += `<c.${desired.c}>`
    }
  }

  const emitText = (segment: string) => {
    if (drawing || segment === '') return
    reconcile()
    out += segment.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const apply = (name: string, value: string) => {
    switch (name) {
      case 'i':
        desired.i = Number.parseInt(value, 10) !== 0
        return
      case 'b': {
        const weight = Number.parseInt(value, 10)
        desired.b = weight === 1 || weight === -1 || weight >= 700
        return
      }
      case 'c':
      case '1c':
        desired.c = value.trim() === '' ? style.color : colorClass(parseAssColor(value.trim()))
        return
      case 'an': {
        const parsed = Number.parseInt(value, 10)
        if (parsed >= 1 && parsed <= 9) alignment = parsed
        return
      }
      case 'a': {
        alignment = normalizeAlignment(Number.parseInt(value, 10), true)
        return
      }
      case 'pos':
      case 'move': {
        const point = parsePoint(value)
        if (point && !pos) pos = point
        return
      }
      case 'p':
        drawing = Number.parseInt(value, 10) > 0
        return
      case 'r': {
        const target = (value.trim() !== '' && info.styles.get(value.trim())) || style
        desired.i = target.italic
        desired.b = target.bold
        desired.c = target.color
        return
      }
    }
  }

  let lastIndex = 0
  for (const block of raw.matchAll(/\{([^}]*)\}/g)) {
    emitText(raw.slice(lastIndex, block.index))
    lastIndex = block.index + block[0].length
    for (const tag of block[1].matchAll(OVERRIDE_TAG)) apply(tag[1], tag[2])
  }
  emitText(raw.slice(lastIndex))
  for (let index = open.length - 1; index >= 0; index -= 1) {
    out += `</${open[index] === 'c' ? 'c' : open[index]}>`
  }

  const text = out
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, ' ')
    .replace(/\\h/g, ' ')
    .trim()
  return { settings: text === '' ? '' : cueSettings(alignment, pos, info), text }
}

// Chromium rejects WebVTT's line-alignment suffix and drops the whole setting
// with it, so a positioned cue's anchor is approximated by lifting the box's
// top edge a nominal text height.
function cueSettings(alignment: number, pos: { x: number; y: number } | null,
  info: AssTrackInfo): string {
  const row = alignment >= 7 ? 'top' : alignment >= 4 ? 'middle' : 'bottom'
  const column = alignment % 3
  const parts: string[] = []
  if (pos) {
    const anchor = row === 'bottom' ? 6 : row === 'middle' ? 3 : 0
    parts.push(`line:${percent(pos.y, info.playResY, anchor)}%`)
    parts.push(`position:${percent(pos.x, info.playResX, 0)}%`)
  } else {
    if (row === 'top') parts.push('line:5%')
    else if (row === 'middle') parts.push('line:47%')
    if (column === 1) parts.push('position:5%')
    else if (column === 0) parts.push('position:95%')
  }
  if (column === 1) parts.push('align:left')
  else if (column === 0) parts.push('align:right')
  return parts.join(' ')
}

function percent(value: number, scale: number, anchor: number): number {
  return Math.min(100, Math.max(0, Math.round((value / scale) * 100) - anchor))
}

function parsePoint(value: string): { x: number; y: number } | null {
  const match = /\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(value)
  if (!match) return null
  return { x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) }
}

// Styles write booleans as 0/-1, and bold sometimes as a font weight.
function assFlag(value: string): boolean {
  const parsed = Number.parseInt(value, 10)
  return parsed === -1 || parsed === 1 || parsed >= 700
}

// The legacy SSA encoding counts 1-3 across the bottom, +4 for top and +8 for
// middle; the numpad one is what everything downstream uses.
function normalizeAlignment(value: number, legacy: boolean): number {
  if (!legacy) return value >= 1 && value <= 9 ? value : 2
  const column = value & 3
  if (column === 0 || Number.isNaN(value)) return 2
  if (value >= 9) return 3 + column
  if (value >= 5) return 6 + column
  return column
}

// ASS colors are &HAABBGGRR& hex (alpha 0 meaning opaque) in v4+ scripts and
// plain decimal BGR in legacy ones. A mostly transparent color is treated as
// unstyled rather than painted opaque.
function parseAssColor(value: string): { r: number; g: number; b: number } | null {
  if (value === '') return null
  const match = /^&H?([0-9a-f]{1,8})&?$/i.exec(value)
  let parsed: number
  if (match) {
    parsed = Number.parseInt(match[1], 16)
  } else {
    parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return null
  }
  if (parsed >>> 24 >= 0xf0) return null
  return { r: parsed & 0xff, g: (parsed >>> 8) & 0xff, b: (parsed >>> 16) & 0xff }
}

function colorClass(rgb: { r: number; g: number; b: number } | null): string | null {
  if (!rgb) return null
  let best = VTT_COLORS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of VTT_COLORS) {
    const distance = (candidate.r - rgb.r) ** 2 + (candidate.g - rgb.g) ** 2 + (candidate.b - rgb.b) ** 2
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best.name === 'white' ? null : best.name
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return parsed > 0 ? parsed : fallback
}

const BOTTOM_DIALOGUE = 'line:-3'
const TOP_DIALOGUE = 'line:2'

/** Only cues with no settings of their own are moved, so this is idempotent. */
export function positionDialogueCues(vtt: string): string {
  const lines = vtt.split('\n')
  let lastBottomEnd = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const arrow = line.indexOf('-->')
    if (arrow < 0) continue
    const start = parseVttStamp(line.slice(0, arrow).trim())
    const [endStamp, ...settings] = line.slice(arrow + 3).trim().split(/\s+/)
    const end = parseVttStamp(endStamp ?? '')
    if (start === null || end === null || settings.length > 0) continue
    if (start < lastBottomEnd) {
      lines[index] = `${line} ${TOP_DIALOGUE}`
    } else {
      lastBottomEnd = end
      lines[index] = `${line} ${BOTTOM_DIALOGUE}`
    }
  }
  return lines.join('\n')
}

function parseVttStamp(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp)
  if (!match) return null
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4])
}
