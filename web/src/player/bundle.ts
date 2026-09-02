/**
 * A region's playlists, fetched together: the server hands the master and the
 * media playlists it names in one response (GET /media/:id/bundle), so a region
 * switch costs one round trip before the first segment instead of three.
 */
import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'

export interface PlaylistBundle {
  master: string
  playlists: Record<string, string>
}

/** The playlist name a request is for: the path's last segment, no query. */
export function playlistNameOf(url: string | undefined): string {
  const path = (url ?? '').split('?')[0].split('#')[0]
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What a bundle can answer for a given name, if anything. */
export function bundledBody(bundle: PlaylistBundle | null, name: string): string | null {
  if (!bundle) return null
  if (name.endsWith('_master.m3u8') || name === 'master.m3u8') return bundle.master
  return Object.prototype.hasOwnProperty.call(bundle.playlists, name) ? bundle.playlists[name] : null
}

/** The init segments a bundle's media playlists name, absolute, once each. */
export function initSegmentsIn(bundle: PlaylistBundle | null): string[] {
  if (!bundle) return []
  const found = new Set<string>()
  for (const body of Object.values(bundle.playlists)) {
    for (const match of body.matchAll(/^#EXT-X-MAP:URI="([^"]+)"/gm)) found.add(match[1])
  }
  return [...found]
}

const BUNDLE_WAIT_MS = 1500

/** Fetches a region's bundle; a failure is no bundle, never an error. */
export async function fetchBundle(roomID: string, masterName: string): Promise<PlaylistBundle | null> {
  try {
    const response = await fetch(`/media/${encodeURIComponent(roomID)}/bundle?master=${encodeURIComponent(masterName)}`)
    if (!response.ok) return null
    const body = await response.json() as Partial<PlaylistBundle>
    if (typeof body.master !== 'string' || typeof body.playlists !== 'object' || body.playlists === null) return null
    return { master: body.master, playlists: body.playlists }
  } catch {
    return null
  }
}

export function prefetchInitSegments(bundle: PlaylistBundle | null): void {
  for (const url of initSegmentsIn(bundle)) {
    void fetch(url).then((response) => response.arrayBuffer()).catch(() => undefined)
  }
}

type LoaderClass = new (config: HlsConfig) => Loader<LoaderContext> & { stats: { loading: { start: number; first: number; end: number }; loaded: number; total: number } }

/**
 * A playlist loader that answers the first request for each bundled playlist
 * from the bundle and everything after from the network: a growing playlist
 * reloads on a timer, and a copy from before it would freeze.
 */
export function bundledLoader(Base: LoaderClass, bundle: Promise<PlaylistBundle | null>): HlsConfig['pLoader'] {
  const served = new Set<string>()
  return class extends Base {
    private answered = false
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const name = playlistNameOf(context.url)
      const playlist = context.type === 'manifest' || context.type === 'level' || context.type === 'audioTrack'
      if (!playlist || !name.endsWith('.m3u8') || served.has(name)) {
        super.load(context, config, callbacks)
        return
      }
      served.add(name)
      const patience = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUNDLE_WAIT_MS))
      void Promise.race([bundle, patience]).then((ready) => {
        if (this.answered) return
        const body = bundledBody(ready, name)
        if (body === null) {
          super.load(context, config, callbacks)
          return
        }
        this.answered = true
        const now = performance.now()
        this.stats.loading.start = now
        this.stats.loading.first = now
        this.stats.loading.end = now
        this.stats.loaded = body.length
        this.stats.total = body.length
        callbacks.onSuccess({ url: context.url, data: body }, this.stats, context, null)
      })
    }
    abort(): void {
      this.answered = true
      super.abort()
    }
    destroy(): void {
      this.answered = true
      super.destroy()
    }
  } as unknown as HlsConfig['pLoader']
}
