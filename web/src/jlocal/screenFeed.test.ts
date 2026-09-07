import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { startJLocalScreenFeed } from './screenFeed'
import { JLOCAL_ORIGIN } from './status'

type PreviewOutcome = 'frame' | 'error'

let previewOutcomes: PreviewOutcome[]
const previewUrls: string[] = []

const drawImage = vi.fn()
const trackStop = vi.fn()
const bitmapClose = vi.fn()
const mockTrack = { stop: trackStop } as unknown as MediaStreamTrack
const mockStream = { getTracks: () => [mockTrack] } as unknown as MediaStream
const AUDIO_FRAME_BYTES = 960 * 2 * 2

/** One 20ms s16le stereo frame: left +0.5, right −0.5. */
function pcmFrame(): Uint8Array {
  const frame = new Uint8Array(AUDIO_FRAME_BYTES)
  const view = new DataView(frame.buffer)
  for (let i = 0; i < 960; i += 1) {
    view.setInt16(i * 4, 16384, true)
    view.setInt16(i * 4 + 2, -16384, true)
  }
  return frame
}

const fakeAudioTrack = { kind: 'audio', enabled: true, stop: vi.fn() }

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  currentTime = 0
  closed = false
  buffers: Array<{ left: Float32Array; right: Float32Array }> = []
  started = 0
  destination = { stream: { getAudioTracks: () => [fakeAudioTrack] } }
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createMediaStreamDestination(): unknown {
    return this.destination
  }
  createBuffer(_channels: number, length: number): unknown {
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    this.buffers.push({ left, right })
    return { getChannelData: (channel: number) => (channel === 0 ? left : right) }
  }
  createBufferSource(): unknown {
    return { connect: () => undefined, start: () => { this.started += 1 } }
  }
  resumed = false
  async resume(): Promise<void> {
    this.resumed = true
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

/** Infinite-body double: chunks drain, then done — or hang mid-stream when told to. */
function pcmBody(chunks: Uint8Array[], onCancel: Mock, hang = false): unknown {
  let index = 0
  return {
    cancel: async () => undefined,
    getReader: () => ({
      cancel: (...args: unknown[]) => {
        onCancel(...args)
        return Promise.resolve()
      },
      read: async () => {
        if (hang) return new Promise<never>(() => undefined)
        if (index < chunks.length) return { done: false, value: chunks[index++] as Uint8Array }
        return { done: true, value: undefined }
      },
    }),
  }
}

/** Routes start/stop plus an /audio/stream double into fetch. */
function stubFetchWithAudio(stream: { ok: boolean; status: number; body?: unknown }): Mock {
  const fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.endsWith('/capture/start')) return { ok: true, status: 200, json: async () => ({}) }
    if (target.endsWith('/capture/stop')) return { ok: true, status: 200, json: async () => ({}) }
    if (target.includes('/capture/preview.jpg')) {
      previewUrls.push(target)
      return { ok: true, status: 200, blob: async () => new Uint8Array([1, 2, 3]) }
    }
    if (target.endsWith('/audio/stream')) {
      if (!stream.ok) return { ok: false, status: stream.status, json: async () => ({}) }
      return { ok: true, status: 200, body: stream.body, json: async () => ({}) }
    }
    throw new Error(`unexpected fetch ${target}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubGlobals(): void {
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

/** Routes /capture/start to ok/status, preview.jpg to frames, and answers /capture/stop 200. */
function stubFetch(startOk: boolean, startStatus = 200, startBody: unknown = {}): Mock {
  const fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.endsWith('/capture/start')) {
      return { ok: startOk, status: startStatus, json: async () => startBody }
    }
    if (target.endsWith('/capture/stop')) {
      return { ok: true, status: 200, json: async () => ({}) }
    }
    if (target.includes('/capture/preview.jpg')) {
      previewUrls.push(target)
      const outcome = previewOutcomes.length > 0 ? previewOutcomes.shift()! : 'frame'
      if (outcome === 'error') throw new Error('frame refused')
      return { ok: true, status: 200, blob: async () => new Uint8Array([1, 2, 3]) }
    }
    throw new Error(`unexpected fetch ${target}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('jlocal screen feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    previewOutcomes = []
    previewUrls.length = 0
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

  it('paints fetched preview frames onto the canvas', async () => {
    stubFetch(true)
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    expect(feed.stream).toBe(mockStream)
    await vi.advanceTimersByTimeAsync(400)
    expect(previewUrls.length).toBeGreaterThanOrEqual(2)
    for (const url of previewUrls) {
      expect(url).toContain(`${JLOCAL_ORIGIN}/capture/preview.jpg`)
    }
    // Each poll busts the cache so a stale JPEG is never repainted.
    for (let n = 1; n < previewUrls.length; n += 1) {
      expect(previewUrls[n]).not.toBe(previewUrls[n - 1])
    }
    expect(drawImage).toHaveBeenCalled()
    feed.stop()
  })

  it('skips failed frames and keeps polling', async () => {
    stubFetch(true)
    previewOutcomes = ['error', 'frame']
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    await vi.advanceTimersByTimeAsync(400)
    expect(previewUrls.length).toBeGreaterThanOrEqual(2)
    expect(drawImage).toHaveBeenCalledTimes(1)
    feed.stop()
  })
  it('reads MJPEG parts from the live stream and skips polling', async () => {
    const encode = new TextEncoder()
    const part = (payload: number[]): Uint8Array => {
      const head = encode.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${payload.length}\r\n\r\n`)
      const body = new Uint8Array(payload)
      const out = new Uint8Array(head.length + body.length + 2)
      out.set(head)
      out.set(body, head.length)
      out.set([13, 10], head.length + body.length)
      return out
    }
    // Two parts: frames extract between boundaries; the split lands mid-frame
    // to prove reassembly across chunk boundaries.
    const wire = new Uint8Array([...part([7, 7, 7]), ...part([9])])
    const chunks = [wire.slice(0, 10), wire.slice(10)]
    let reads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const target = String(url)
        if (target.endsWith('/capture/start')) return { ok: true, status: 200, json: async () => ({}) }
        if (target.endsWith('/capture/stop')) return { ok: true, status: 200, json: async () => ({}) }
        if (target.endsWith('/capture/stream')) {
          return {
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                read: async () => {
                  reads += 1
                  if (reads <= chunks.length) return { done: false, value: chunks[reads - 1] }
                  // Park the stream: the test ends via stop(), not EOF.
                  await new Promise(() => {})
                  return { done: true, value: undefined };
                },
                cancel: async () => undefined,
              }),
            },
            json: async () => ({}),
          }
        }
        throw new Error(`unexpected fetch ${target}`)
      }),
    )
    const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
    await vi.advanceTimersByTimeAsync(100)
    expect(drawImage).toHaveBeenCalled()
    // Live stream won: no polling fallback polls fired.
    expect(previewUrls).toHaveLength(0)
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
    const pollsBefore = previewUrls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawImage).not.toHaveBeenCalled()
    expect(previewUrls).toHaveLength(pollsBefore)
  })

  it('stop swallows a failing capture-stop release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/capture/stop')) throw new Error('app gone')
        if (String(url).includes('/capture/preview.jpg')) {
          return { ok: true, status: 200, blob: async () => new Uint8Array([1]) }
        }
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
  describe('system audio', () => {
    const added: unknown[] = []
    let addTrack: Mock
    let readerCancel: Mock

    beforeEach(() => {
      added.length = 0
      FakeAudioContext.instances.length = 0
      fakeAudioTrack.enabled = true
      readerCancel = vi.fn(async () => undefined)
      addTrack = vi.fn((track: unknown) => {
        added.push(track)
      })
      Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
        configurable: true,
        writable: true,
        value: vi.fn().mockReturnValue({ getTracks: () => [mockTrack], getAudioTracks: () => added, addTrack }),
      })
      vi.stubGlobal('AudioContext', FakeAudioContext)
    })

    it('appends a decoded audio track when PCM frames arrive split across reads', async () => {
      const frame = pcmFrame()
      const fetchMock = stubFetchWithAudio({
        ok: true,
        status: 200,
        body: pcmBody([frame.subarray(0, 1000), frame.subarray(1000)], readerCancel),
      })
      const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5, audio: true })
      await vi.advanceTimersByTimeAsync(50)
      expect(fetchMock).toHaveBeenCalledWith(`${JLOCAL_ORIGIN}/audio/stream`)
      expect(addTrack).toHaveBeenCalledWith(fakeAudioTrack)
      const context = FakeAudioContext.instances[0]
      expect(context).toBeDefined()
      expect(context?.started).toBeGreaterThanOrEqual(1)
      expect(context?.resumed).toBe(true)
      // s16le decode lands on float samples: left +0.5, right −0.5.
      expect(context?.buffers[0]?.left[0]).toBeCloseTo(0.5, 5)
      expect(context?.buffers[0]?.right[0]).toBeCloseTo(-0.5, 5)
      feed.stop()
    })

    it('resolves video-only when the app answers 404 idle', async () => {
      stubFetchWithAudio({ ok: false, status: 404 })
      const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5, audio: true })
      await vi.advanceTimersByTimeAsync(50)
      expect(addTrack).not.toHaveBeenCalled()
      expect(FakeAudioContext.instances).toHaveLength(0)
      expect(feed.stream.getTracks()).toEqual([mockTrack])
      feed.stop()
    })

    it('never opens the audio stream without the flag', async () => {
      const fetchMock = stubFetchWithAudio({ ok: false, status: 501 })
      const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5 })
      await vi.advanceTimersByTimeAsync(50)
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/audio/stream'))).toBe(false)
      expect(addTrack).not.toHaveBeenCalled()
      feed.stop()
    })

    it('stop cancels the reader and closes the context', async () => {
      const fetchMock = stubFetchWithAudio({
        ok: true,
        status: 200,
        body: pcmBody([], readerCancel, true),
      })
      const feed = await startJLocalScreenFeed({ kind: 'display', id: 'display-1' }, { width: 320, height: 200, fps: 5, audio: true })
      // The hanging read means the loop holds an open reader and context here.
      await vi.advanceTimersByTimeAsync(50)
      expect(addTrack).toHaveBeenCalledTimes(1)
      const context = FakeAudioContext.instances[0]
      expect(context?.closed).toBe(false)
      feed.stop()
      expect(readerCancel).toHaveBeenCalled()
      expect(context?.closed).toBe(true)
      expect(trackStop).toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledWith(`${JLOCAL_ORIGIN}/capture/stop`, expect.objectContaining({ method: 'POST' }))
    })
  })
})
