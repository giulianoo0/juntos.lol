import type { MetaType } from './cinemeta'

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
]

export type StreamResolution = '2160p' | '1080p' | '720p' | 'sd'

export type StreamLocation =
  | { kind: 'torrent'; infoHash: string; fileIdx: number | null; fileName: string }
  | { kind: 'url'; url: string }

export interface CatalogStream {
  quality: string
  resolution: StreamResolution
  label: string
  seeders: number | null
  size: string
  source: string
  languages: string[]
  location: StreamLocation
  pluginId: string
  pluginName: string
}

export interface StreamTarget {
  type: MetaType
  id: string
  season?: number
  episode?: number
}

const FLAG_PATTERN = /\p{Regional_Indicator}\p{Regional_Indicator}/gu
const FLAG_TEST = /\p{Regional_Indicator}\p{Regional_Indicator}/u
const PT_BR_MARKERS = /dublado|dual[\s.]?(audio|áudio)?|nacional|dublagem/i

export function parseStreamTitle(title: string): { label: string; seeders: number | null; size: string; source: string; languages: string[] } {
  const lines = title.split('\n')
  const statsLine = lines.find((line) => line.includes('👤') || line.includes('💾')) ?? ''
  const languageLines = lines.filter((line) => line !== statsLine && FLAG_TEST.test(line))
  const seeders = /👤\s*(\d+)/.exec(statsLine)
  const size = /💾\s*([\d.,]+\s*[KMGT]?B)/.exec(statsLine)
  const source = /⚙️\s*(.+?)\s*$/.exec(statsLine)
  const label = lines.filter((line) => line !== statsLine && !languageLines.includes(line) && line.trim() !== '').join(' ')
  const languages = [...new Set(languageLines.flatMap((line) => line.match(FLAG_PATTERN) ?? []))]
  if (PT_BR_MARKERS.test(label) && !languages.includes('🇧🇷')) languages.push('🇧🇷')
  return {
    label,
    seeders: seeders ? Number(seeders[1]) : null,
    size: size ? size[1] : '',
    source: source ? source[1] : '',
    languages,
  }
}

export function streamResolution(quality: string, label: string): StreamResolution {
  const haystack = `${quality} ${label}`.toLowerCase()
  if (/\b(2160p|4k)\b/.test(haystack)) return '2160p'
  if (/\b1080p\b/.test(haystack)) return '1080p'
  if (/\b720p\b/.test(haystack)) return '720p'
  return 'sd'
}

/**
 * Where a stream points, or null if nowhere usable. A torrent wins over a url
 * when a stream carries both, and `http:` is refused outright.
 */
function readLocation(stream: Record<string, unknown>): StreamLocation | null {
  if (typeof stream.infoHash === 'string' && /^[0-9a-f]{40}$/i.test(stream.infoHash)) {
    const hints = typeof stream.behaviorHints === 'object' && stream.behaviorHints !== null
      ? stream.behaviorHints as Record<string, unknown>
      : {}
    return {
      kind: 'torrent',
      infoHash: stream.infoHash.toLowerCase(),
      fileIdx: typeof stream.fileIdx === 'number' && Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0
        ? stream.fileIdx
        : null,
      fileName: typeof hints.filename === 'string' ? hints.filename : '',
    }
  }
  if (typeof stream.url === 'string') {
    try {
      const url = new URL(stream.url)
      if (url.protocol === 'https:' && !url.username && !url.password) {
        return { kind: 'url', url: url.href }
      }
    } catch { }
  }
  return null
}

const MAX_STREAMS = 500
const MAX_TITLE = 2_000

export function parseStreams(payload: unknown, pluginId: string, pluginName = ''): CatalogStream[] {
  if (typeof payload !== 'object' || payload === null) return []
  const streams = (payload as { streams?: unknown }).streams
  if (!Array.isArray(streams)) return []
  const result: CatalogStream[] = []
  for (const value of streams) {
    if (result.length >= MAX_STREAMS) break
    if (typeof value !== 'object' || value === null) continue
    const stream = value as Record<string, unknown>
    const location = readLocation(stream)
    if (!location) continue
    const title = typeof stream.title === 'string' ? stream.title.slice(0, MAX_TITLE) : ''
    const parsed = parseStreamTitle(title)
    const quality = typeof stream.name === 'string' ? stream.name.split('\n').slice(1).join(' ') || stream.name : ''
    result.push({
      quality,
      resolution: streamResolution(quality, parsed.label),
      label: parsed.label,
      seeders: parsed.seeders,
      size: parsed.size,
      source: parsed.source,
      languages: parsed.languages,
      location,
      pluginId,
      pluginName,
    })
  }
  return result
}

export function buildMagnet(location: Extract<StreamLocation, { kind: 'torrent' }>, label: string): string {
  const name = location.fileName || label
  const dn = name ? `&dn=${encodeURIComponent(name)}` : ''
  const trackers = TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('')
  return `magnet:?xt=urn:btih:${location.infoHash}${dn}${trackers}`
}

/** A React key; the plugin is part of it, since two plugins may return one torrent. */
export function streamKey(stream: CatalogStream): string {
  const { location } = stream
  const where = location.kind === 'torrent'
    ? `torrent:${location.infoHash}:${location.fileIdx ?? ''}:${location.fileName}`
    : `url:${location.url}`
  return `${stream.pluginId}:${where}`
}

/** Both kinds open today; the check stays so a new source kind is not listed as playable. */
export function isPlayable(stream: CatalogStream): boolean {
  return stream.location.kind === 'torrent' || stream.location.kind === 'url'
}
