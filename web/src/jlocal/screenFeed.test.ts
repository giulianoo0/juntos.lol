import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { startJLocalScreenFeed } from './screenFeed'
import { JLOCAL_ORIGIN } from './status'

type ImageOutcome = 'load' | 'error'

let imageOutcomes: ImageOutcome[]
const imageSrcs: string[] = []

/** Resolves onload/onerror on src assignment, like a loopback JPEG fetch. */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  get src(): string {
    return this._src
  }
  set src(value: string) {
    this._src = value
    imageSrcs.push(value)
    const outcome = imageOutcomes.length > 0 ? imageOutcomes.shift()! : 'load'
    queueMicrotask(() => {
      if (outcome === 'load') this.onload?.()
      else this.onerror?.()
    })
  }
}

const drawImage = vi.fn()
const trackStop = vi.fn()
const bitmapClose = vi.fn()
const mockTrack = { stop: trackStop } as unknown as MediaStreamTrack
const mockStream = { getTracks: () => [mockTrack] } as unknown as MediaStream

function stubGlobals(): void {
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: bitmapClose }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ({ drawImage })) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mockStream),
  })
}

/** Routes /capture/start to ok/status and answers /capture/stop 200. */
function stubFetch(startOk: boolean, startStatus = 200, startBody: unknown = {}): Mock {
  const fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.endsWith('/capture/start')) {
      return { ok: startOk, status: startStatus, json: async () => startBody }
    }
    if (target.endsWith('/capture/stop')) {
      return { ok: true, status: 200, json: async () => ({}) }
    }
    throw new Error(`unexpected fetch ${target}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('jlocal screen feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    imageOutcomes = []
    imageSrcs.length = 0
    drawImage.mockClear()
    trackStop.mockClear()
    bitmapClose.mockClear()
    stubGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('posts the start request with display, size, and fps', async () => {
    const fetchMock = stubFetch(true)
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 1280, height: 720, fps: 5 })
    expect(fetchMock).toHaveBeenCalledWith(
      `${JLOCAL_ORIGIN}/capture/start`,
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ display_id: 'display-1', width: 1280, height: 720, fps: 5 })
    feed.stop()
  })
  it('posts window_id for a window target', async () => {
    const fetchMock = stubFetch(true)
    const feed = await startJLocalScreenFeed({ kind: 'window', id: '42' }, { width: 1280, height: 720, fps: 30 })
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ window_id: '42', width: 1280, height: 720, fps: 30 })
    feed.stop()
  })

  it('paints preview frames onto the canvas stream without fetching them', async () => {
    const fetchMock = stubFetch(true)
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    expect(feed.stream).toBe(mockStream)
    await vi.advanceTimersByTimeAsync(400)
    expect(imageSrcs.length).toBeGreaterThanOrEqual(2)
    for (const src of imageSrcs) {
      expect(src).toContain(`${JLOCAL_ORIGIN}/capture/preview.jpg`)
    }
    // Each poll busts the cache so a stale JPEG is never repainted.
    for (let n = 1; n < imageSrcs.length; n += 1) {
      expect(imageSrcs[n]).not.toBe(imageSrcs[n - 1])
    }
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('preview'))).toBe(true)
    expect(drawImage).toHaveBeenCalled()
    feed.stop()
  })

  it('skips failed frames and keeps polling', async () => {
    stubFetch(true)
    imageOutcomes = ['error', 'load']
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    await vi.advanceTimersByTimeAsync(400)
    expect(imageSrcs.length).toBeGreaterThanOrEqual(2)
    expect(drawImage).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('stop halts polling, stops tracks, and posts capture stop once', async () => {
    const fetchMock = stubFetch(true)
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    await vi.advanceTimersByTimeAsync(200)
    expect(drawImage).toHaveBeenCalled()
    feed.stop()
    feed.stop()
    expect(trackStop).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      `${JLOCAL_ORIGIN}/capture/stop`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/capture/stop'))).toHaveLength(1)
    drawImage.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawImage).not.toHaveBeenCalled()
    expect(imageSrcs).toHaveLength(1)
  })

  it('stop swallows a failing capture-stop release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/capture/stop')) throw new Error('app gone')
        return { ok: true, status: 200, json: async () => ({}) }
      }),
    )
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    expect(() => feed.stop()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(trackStop).toHaveBeenCalled()
  })

  it("throws jlocal-capture-unavailable when start answers 501", async () => {
    stubFetch(false, 501)
    await expect(startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })).rejects.toThrow(
      'jlocal-capture-unavailable',
    )
  })

  it('throws jlocal-capture-unavailable when the app is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('refused')
      }),
    )
    await expect(startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })).rejects.toThrow(
      'jlocal-capture-unavailable',
    )
  })
  it('throws jlocal-capture-permission when start answers 503', async () => {
    stubFetch(false, 503, { error: 'permission' })
    await expect(startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })).rejects.toThrow(
      'jlocal-capture-permission',
    )
  })
  it('carries the grab reason when start answers 503 without permission', async () => {
    stubFetch(false, 503, { error: 'capture failed (display 1): os denied the grab' })
    await expect(startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })).rejects.toThrow(
      'capture failed (display 1): os denied the grab',
    )
  })

  it('carries the server reason when start refuses the request', async () => {
    stubFetch(false, 400, { error: 'requested 2560x1440 exceeds display 1 size 1512x982' })
    await expect(startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 2560, height: 1440, fps: 30 })).rejects.toThrow(
      'requested 2560x1440 exceeds display 1 size 1512x982',
    )
  })
})
