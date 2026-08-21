import type { MetaType } from './cinemeta'

// Any Stremio-protocol stream addon works here; Torrentio is the default. The
// addon only returns torrent identifiers (infoHash + file hints) — the bytes
// flow through the room's existing torrent pipeline, never through the addon.
const ADDON_BASE = (import.meta.env.VITE_STREAM_ADDON as string | undefined)?.replace(/\/$/, '')
  ?? 'https://torrentio.strem.fun'

// The magnet alone identifies the torrent; these public trackers are the same
// kind the manual magnet flow relies on for peer discovery.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
]

export type StreamResolution = '2160p' | '1080p' | '720p' | 'sd'

export interface CatalogStream {
  // First line of the addon's name field, e.g. "Torrentio 1080p".
  quality: string
  resolution: StreamResolution
  // The release name, cleaned of the stats and language lines.
  label: string
  seeders: number | null
  size: string
  source: string
  // Flag emojis for the languages the release carries — Torrentio lists a
  // flag whether the language comes as audio or as subtitles, which is
  // exactly what the language filter wants.
  languages: string[]
  infoHash: string
  fileName: string
}

export interface StreamTarget {
  type: MetaType
  id: string
  season?: number
  episode?: number
}

const FLAG_PATTERN = /\p{Regional_Indicator}\p{Regional_Indicator}/gu
// `test` on a global regex advances lastIndex between calls; detection needs
// its own stateless copy.
const FLAG_TEST = /\p{Regional_Indicator}\p{Regional_Indicator}/u
// Release-name markers for Brazilian dubbed/dual audio; those releases often
// skip the flag line, and the language filter must still find them.
const PT_BR_MARKERS = /dublado|dual[\s.]?(audio|áudio)?|nacional|dublagem/i

// Torrentio packs the release name plus a stats line ("👤 12 💾 1.4 GB ⚙️ x")
// and sometimes a language line ("Multi Subs / 🇧🇷 / 🇪🇸") into `title`,
// newline-separated. Pull those apart so the list can render fields and
// filters instead of emoji soup.
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

// The resolution bucket comes from the addon's own quality tag, falling back
// to the release name.
export function streamResolution(quality: string, label: string): StreamResolution {
  const haystack = `${quality} ${label}`.toLowerCase()
  if (/\b(2160p|4k)\b/.test(haystack)) return '2160p'
  if (/\b1080p\b/.test(haystack)) return '1080p'
  if (/\b720p\b/.test(haystack)) return '720p'
  return 'sd'
}

export function parseStreams(payload: unknown): CatalogStream[] {
  if (typeof payload !== 'object' || payload === null) return []
  const streams = (payload as { streams?: unknown }).streams
  if (!Array.isArray(streams)) return []
  const result: CatalogStream[] = []
  for (const value of streams) {
    if (typeof value !== 'object' || value === null) continue
    const stream = value as Record<string, unknown>
    if (typeof stream.infoHash !== 'string' || !/^[0-9a-f]{40}$/i.test(stream.infoHash)) continue
    const title = typeof stream.title === 'string' ? stream.title : ''
    const hints = typeof stream.behaviorHints === 'object' && stream.behaviorHints !== null
      ? stream.behaviorHints as Record<string, unknown>
      : {}
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
      infoHash: stream.infoHash.toLowerCase(),
      fileName: typeof hints.filename === 'string' ? hints.filename : '',
    })
  }
  return result
}

export async function fetchStreams(target: StreamTarget): Promise<CatalogStream[]> {
  const id = target.type === 'series' && target.season != null && target.episode != null
    ? `${target.id}:${target.season}:${target.episode}`
    : target.id
  const response = await fetch(`${ADDON_BASE}/stream/${target.type}/${encodeURIComponent(id)}.json`)
  if (!response.ok) throw new Error(`stream addon ${response.status}`)
  return parseStreams(await response.json())
}

export function buildMagnet(stream: CatalogStream): string {
  const name = stream.fileName || stream.label
  const dn = name ? `&dn=${encodeURIComponent(name)}` : ''
  const trackers = TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('')
  return `magnet:?xt=urn:btih:${stream.infoHash}${dn}${trackers}`
}
