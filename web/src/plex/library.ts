import { plexHeaders, type PlexDeps } from './account'

export interface PlexItem {
  ratingKey: string
  title: string
  year: number | null
  type: 'movie' | 'episode'
  partKey: string
  size: number
  container: string
}

/** What a watch party can play. The account may also hold music and photos. */
const PLAYABLE = new Set(['movie', 'episode'])

async function get(base: string, token: string, path: string, deps: PlexDeps): Promise<Record<string, unknown>> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request(`${base}${path}`, {
    headers: { ...await plexHeaders(), 'X-Plex-Token': token },
  })
  if (!response.ok) throw new Error(`plex request failed (${response.status})`)
  return await response.json() as Record<string, unknown>
}

function metadata(body: Record<string, unknown>): Record<string, unknown>[] {
  const container = body.MediaContainer as Record<string, unknown> | undefined
  const list = container?.Metadata
  return Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null) : []
}

export async function listSections(base: string, token: string, deps: PlexDeps = {}): Promise<{ key: string; title: string }[]> {
  const body = await get(base, token, '/library/sections', deps)
  const container = body.MediaContainer as Record<string, unknown> | undefined
  const directories = Array.isArray(container?.Directory) ? container.Directory : []
  return directories
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => entry.type === 'movie' || entry.type === 'show')
    .map((entry) => ({ key: String(entry.key ?? ''), title: String(entry.title ?? '') }))
}

/** Titles only — the file behind one is read separately, by itemDetails. */
export async function searchLibrary(
  base: string, token: string, query: string, deps: PlexDeps = {},
): Promise<Pick<PlexItem, 'ratingKey' | 'title' | 'year' | 'type'>[]> {
  // `/search` is the legacy endpoint. Current servers also expose
  // `/hubs/search`, whose answer is MediaContainer.Hub[] rather than
  // Metadata[]. `/search` still answers; noted as debt, not fixed here.
  const body = await get(base, token, `/search?query=${encodeURIComponent(query)}`, deps)
  return metadata(body)
    .filter((entry) => typeof entry.type === 'string' && PLAYABLE.has(entry.type))
    .map((entry) => ({
      ratingKey: String(entry.ratingKey ?? ''),
      title: String(entry.title ?? ''),
      year: typeof entry.year === 'number' ? entry.year : null,
      type: entry.type as 'movie' | 'episode',
    }))
}

export async function itemDetails(base: string, token: string, ratingKey: string, deps: PlexDeps = {}): Promise<PlexItem> {
  const body = await get(base, token, `/library/metadata/${encodeURIComponent(ratingKey)}`, deps)
  const [entry] = metadata(body)
  if (!entry) throw new Error('plex: no such item')
  const media = Array.isArray(entry.Media) ? entry.Media[0] as Record<string, unknown> | undefined : undefined
  const part = media && Array.isArray(media.Part) ? media.Part[0] as Record<string, unknown> | undefined : undefined
  if (!part || typeof part.key !== 'string') throw new Error('plex: this title has no playable file')
  return {
    ratingKey: String(entry.ratingKey ?? ratingKey),
    title: String(entry.title ?? ''),
    year: typeof entry.year === 'number' ? entry.year : null,
    type: entry.type === 'episode' ? 'episode' : 'movie',
    partKey: part.key,
    size: typeof part.size === 'number' ? part.size : 0,
    container: typeof media?.container === 'string' ? media.container : 'mkv',
  }
}

/**
 * The original file, not a transcode.
 *
 * `download=1` marks the response as a download, and it is what triggers the
 * permission check — Plex only serves the original file to a user with "Allow
 * Downloads" enabled. A 403 here means that setting, not a bad token, and the
 * interface has to say so; otherwise it reads as a login problem and the
 * person re-pairs for ever.
 *
 * (Direct play works without `download=1` too. What the parameter buys is the
 * original bytes rather than whatever the server would transcode.)
 */
export function partUrl(base: string, partKey: string, token: string): string {
  return `${base}${partKey}?download=1&X-Plex-Token=${encodeURIComponent(token)}`
}
