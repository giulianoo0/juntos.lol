import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import { prefetchingLoader } from './prefetch'

class FakeBase {
  static loads: string[] = []
  stats = { loading: { start: 0, first: 0, end: 0 }, loaded: 0, total: 0 }
  constructor(_config: HlsConfig) {}
  load(context: LoaderContext) { FakeBase.loads.push(context.url) }
  abort() {}
  destroy() {}
}

const segment = (n: number) => ({ url: `https://media/r/hls/cs_1_${n}.m4s` }) as LoaderContext
const callbacks = () => ({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() }) as unknown as LoaderCallbacks<LoaderContext>

describe('prefetching loader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeBase.loads = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const make = () => {
    const Loader = prefetchingLoader(FakeBase as never) as unknown as new (config: HlsConfig) => FakeBase & {
      load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void
    }
    return () => new Loader({} as HlsConfig)
  }

  it('falls back to the network when a warmed fetch never answers', async () => {
    const loader = make()
    loader().load(segment(1), {} as LoaderConfiguration, callbacks())
    loader().load(segment(2), {} as LoaderConfiguration, callbacks())
    expect(FakeBase.loads).toEqual([segment(1).url])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeBase.loads).toEqual([segment(1).url, segment(2).url])
  })

  it('reports an abort while it waits on a warmed fetch', () => {
    const loader = make()
    loader().load(segment(1), {} as LoaderConfiguration, callbacks())
    const waiting = loader()
    const answers = callbacks()
    waiting.load(segment(2), {} as LoaderConfiguration, answers)
    waiting.abort()
    expect(answers.onAbort).toHaveBeenCalledTimes(1)
  })
})
