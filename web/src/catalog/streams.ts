import type { MetaType } from './cinemeta'

// The magnet alone identifies the torrent; these public trackers are the same
// kind the manual magnet flow relies on for peer discovery.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
]

export type StreamResolution = '2160p' | '1080p' | '720p' | 'sd'

/**
 * Where a stream's bytes actually are.
 *
 * A plugin points at them one of two ways, and the two travel very different
 * paths afterwards: a torrent goes through the swarm, a url is fetched by
 * whoever can reach it.
 */
export type StreamLocation =
  | { kind: 'torrent'; infoHash: string; fileIdx: number | null; fileName: string }
  | { kind: 'url'; url: string }

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
  location: StreamLocation
  /** The registry key of the plugin that produced this. Opaque. */
  pluginId: string
  /** What that plugin calls itself, which is what a person can act on. */
  pluginName: string
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

/**
 * Reads where a stream points, or null if it points nowhere usable.
 *
 * A torrent wins over a url when a stream carries both: the swarm costs
 * nobody's server anything. `http:` is refused outright — the page is https,
 * and a url the server would later have to fetch gets checked again there.
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
      // Credentials here would have the server send Basic auth to an address
      // a plugin chose — the same reason parseManifest refuses them in
      // updateUrl. And what gets stored is the form that was checked, not
      // the form that was written: `https:\n//host` parses fine and would
      // carry the newline all the way to whoever builds the request.
      if (url.protocol === 'https:' && !url.username && !url.password) {
        return { kind: 'url', url: url.href }
      }
    } catch { /* not a url at all */ }
  }
  return null
}

/** A list nobody scrolls to the end of. */
const MAX_STREAMS = 500
/** A release name, not a document. */
const MAX_TITLE = 2_000

export function parseStreams(payload: unknown, pluginId: string, pluginName = ''): CatalogStream[] {
  if (typeof payload !== 'object' || payload === null) return []
  const streams = (payload as { streams?: unknown }).streams
  if (!Array.isArray(streams)) return []
  const result: CatalogStream[] = []
  for (const value of streams) {
    // Ten thousand streams is five regexes and an allocation each, on the
    // main thread, over data a plugin chose.
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

/**
 * Identifies one stream among the ones on screen, for React keys.
 *
 * The plugin is part of it: two plugins returning the same torrent is the
 * normal case — having more than one is the point — and without it they
 * collide.
 */
export function streamKey(stream: CatalogStream): string {
  const { location } = stream
  const where = location.kind === 'torrent'
    ? `torrent:${location.infoHash}:${location.fileIdx ?? ''}:${location.fileName}`
    : `url:${location.url}`
  return `${stream.pluginId}:${where}`
}

/**
 * Whether this build can open a source at all.
 *
 * A url stream has nowhere to go until the server-side ingest exists. Listing
 * one as if it were playable and throwing on click is worse than not offering
 * it — see openCatalogStream, which refuses url streams outright.
 */
export function isPlayable(stream: CatalogStream): boolean {
  return stream.location.kind === 'torrent'
}
