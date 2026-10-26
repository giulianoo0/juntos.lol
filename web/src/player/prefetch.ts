/**
 * A fragment loader that keeps the next few segments in flight: hls.js fetches
 * strictly one fragment at a time, so the numbered segments after the current
 * one (…cs_0_154.m4s) are fetched in parallel and answered from memory.
 */
import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import { recordTransfer } from './playbackHealth'

const LOOKAHEAD = 3
const CACHE_MAX = 8
const FRESH_MS = 30_000
/**
 * A warmed fetch answers hls.js outside its own loader, so none of its
 * timeouts apply: one that stalls would hold the track in loading for good.
 * Past this long the fragment goes to the network like any other.
 */
const HIT_PATIENCE_MS = 8_000
const WARM_TIMEOUT_MS = 20_000

/** The URL `step` segments after this one, or null off the naming scheme. */
export function nextSegmentUrl(url: string, step: number): string | null {
  const match = /^(.*_)(\d+)(\.m4s)$/.exec(url)
  if (!match) return null
  return `${match[1]}${Number(match[2]) + step}${match[3]}`
}

interface Warmed {
  at: number
  promise: Promise<ArrayBuffer | null>
}

type LoaderClass = new (config: HlsConfig) => Loader<LoaderContext> & {
  stats: { loading: { start: number; first: number; end: number }; loaded: number; total: number }
}

export function prefetchingLoader(Base: LoaderClass): HlsConfig['fLoader'] {
  const warmed = new Map<string, Warmed>()
  const warm = (url: string) => {
    if (warmed.has(url)) return
    while (warmed.size >= CACHE_MAX) {
      const oldest = warmed.keys().next().value
      if (oldest === undefined) break
      warmed.delete(oldest)
    }
    const at = performance.now()
    warmed.set(url, {
      at,
      promise: fetch(url, { signal: AbortSignal.timeout(WARM_TIMEOUT_MS) })
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((data) => {
          if (data) recordTransfer(at, performance.now(), data.byteLength)
          return data
        })
        .catch(() => null),
    })
  }
  return class extends Base {
    private answered = false
    /** Set while a warmed fetch, not the base loader, owes hls.js an answer. */
    private waiting: { context: LoaderContext; callbacks: LoaderCallbacks<LoaderContext>; timer: number } | null = null
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const url = context.url ?? ''
      const whole = context.rangeStart === undefined && context.rangeEnd === undefined
      if (whole && /\.m4s$/.test(url)) {
        for (let step = 1; step <= LOOKAHEAD; step++) {
          const next = nextSegmentUrl(url, step)
          if (next) warm(next)
        }
        const hit = warmed.get(url)
        if (hit && performance.now() - hit.at <= FRESH_MS) {
          warmed.delete(url)
          let timer = 0
          const patience = new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), HIT_PATIENCE_MS) })
          this.waiting = { context, callbacks, timer }
          void Promise.race([hit.promise, patience]).then((data) => {
            window.clearTimeout(timer)
            if (this.answered) return
            this.waiting = null
            if (!data || data.byteLength === 0) {
              super.load(context, config, callbacks)
              return
            }
            this.answered = true
            const now = performance.now()
            this.stats.loading.start = hit.at
            this.stats.loading.first = now
            this.stats.loading.end = now
            this.stats.loaded = data.byteLength
            this.stats.total = data.byteLength
            callbacks.onSuccess({ url, data }, this.stats, context, null)
          })
          return
        }
        warmed.delete(url)
      }
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, loaded, details) => {
          recordTransfer(stats.loading.start, stats.loading.end, stats.loaded)
          callbacks.onSuccess(response, stats, loaded, details)
        },
      })
    }
    abort(): void {
      this.answered = true
      const waiting = this.release()
      super.abort()
      waiting?.callbacks.onAbort?.(this.stats as never, waiting.context, null)
    }
    destroy(): void {
      this.answered = true
      this.release()
      super.destroy()
    }
    private release() {
      const waiting = this.waiting
      this.waiting = null
      if (waiting) window.clearTimeout(waiting.timer)
      return waiting
    }
  } as unknown as HlsConfig['fLoader']
}
