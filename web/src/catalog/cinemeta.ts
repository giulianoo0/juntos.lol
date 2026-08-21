// Cinemeta is Stremio's public metadata addon. Catalogs and search live under
// v3-cinemeta.strem.io (the popular catalogs redirect to a static mirror, which
// fetch follows), and every response is CORS-open, so the browser talks to it
// directly — the server never proxies catalog traffic.
const CINEMETA = 'https://v3-cinemeta.strem.io'

export type MetaType = 'movie' | 'series'

export interface CatalogMeta {
  id: string
  type: MetaType
  name: string
  poster: string
  releaseInfo: string
}

export interface MetaVideo {
  id: string
  season: number
  episode: number
  name: string
  released?: string
  thumbnail?: string
  overview?: string
}

export interface MetaDetail extends CatalogMeta {
  background: string
  logo: string
  description: string
  runtime: string
  imdbRating: string
  genres: string[]
  cast: string[]
  director: string[]
  videos: MetaVideo[]
}

const cache = new Map<string, Promise<unknown>>()

async function getJSON<T>(url: string): Promise<T> {
  let pending = cache.get(url)
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`cinemeta ${response.status}`)
      return response.json() as Promise<unknown>
    })
    cache.set(url, pending)
    // A failed fetch must not poison the cache: the catalog retries on demand.
    pending.catch(() => cache.delete(url))
  }
  return await (pending as Promise<T>)
}

function isMetaType(value: unknown): value is MetaType {
  return value === 'movie' || value === 'series'
}

// Search results and catalog rows share one wire shape; anything without the
// fields a poster card needs is dropped rather than rendered broken.
export function parseCatalogMetas(payload: unknown, fallbackType?: MetaType): CatalogMeta[] {
  if (typeof payload !== 'object' || payload === null) return []
  const metas = (payload as { metas?: unknown }).metas
  if (!Array.isArray(metas)) return []
  const result: CatalogMeta[] = []
  for (const value of metas) {
    if (typeof value !== 'object' || value === null) continue
    const meta = value as Record<string, unknown>
    const type = isMetaType(meta.type) ? meta.type : fallbackType
    if (typeof meta.id !== 'string' || meta.id === '' || typeof meta.name !== 'string' || !type) continue
    result.push({
      id: meta.id,
      type,
      name: meta.name,
      poster: typeof meta.poster === 'string' ? meta.poster : '',
      releaseInfo: typeof meta.releaseInfo === 'string' ? meta.releaseInfo : '',
    })
  }
  return result
}

export function parseMetaDetail(payload: unknown): MetaDetail | null {
  if (typeof payload !== 'object' || payload === null) return null
  const meta = (payload as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return null
  const value = meta as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || !isMetaType(value.type)) return null
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  const videos: MetaVideo[] = []
  if (Array.isArray(value.videos)) {
    for (const raw of value.videos) {
      if (typeof raw !== 'object' || raw === null) continue
      const video = raw as Record<string, unknown>
      if (typeof video.id !== 'string' || typeof video.season !== 'number' || typeof video.episode !== 'number') continue
      videos.push({
        id: video.id,
        season: video.season,
        episode: video.episode,
        name: typeof video.name === 'string' ? video.name : '',
        released: typeof video.released === 'string' ? video.released : undefined,
        thumbnail: typeof video.thumbnail === 'string' ? video.thumbnail : undefined,
        overview: typeof video.overview === 'string' ? video.overview : undefined,
      })
    }
  }
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    poster: typeof value.poster === 'string' ? value.poster : '',
    releaseInfo: typeof value.releaseInfo === 'string' ? value.releaseInfo : (typeof value.year === 'string' ? value.year : ''),
    background: typeof value.background === 'string' ? value.background : '',
    logo: typeof value.logo === 'string' ? value.logo : '',
    description: typeof value.description === 'string' ? value.description : '',
    runtime: typeof value.runtime === 'string' ? value.runtime : '',
    imdbRating: typeof value.imdbRating === 'string' ? value.imdbRating : '',
    genres: strings(value.genre ?? value.genres),
    cast: strings(value.cast),
    director: strings(value.director),
    videos,
  }
}

export async function fetchCatalog(type: MetaType, genre?: string): Promise<CatalogMeta[]> {
  const extra = genre ? `/genre=${encodeURIComponent(genre)}` : ''
  const payload = await getJSON<unknown>(`${CINEMETA}/catalog/${type}/top${extra}.json`)
  return parseCatalogMetas(payload, type)
}

export async function fetchMeta(type: MetaType, id: string): Promise<MetaDetail | null> {
  const payload = await getJSON<unknown>(`${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`)
  return parseMetaDetail(payload)
}

// One query fans out to both types; movies and series come back interleaved by
// each list's own ranking, movies first on ties.
export async function searchCatalog(query: string): Promise<CatalogMeta[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const search = `search=${encodeURIComponent(trimmed)}`
  const [movies, series] = await Promise.all(
    (['movie', 'series'] as const).map(async (type) => {
      try {
        const payload = await getJSON<unknown>(`${CINEMETA}/catalog/${type}/top/${search}.json`)
        return parseCatalogMetas(payload, type)
      } catch {
        return []
      }
    }),
  )
  const merged: CatalogMeta[] = []
  for (let index = 0; index < Math.max(movies.length, series.length); index += 1) {
    if (index < movies.length) merged.push(movies[index])
    if (index < series.length) merged.push(series[index])
  }
  return merged
}
