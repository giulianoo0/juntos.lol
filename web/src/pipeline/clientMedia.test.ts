// Drives the region machinery of the client pipeline with a scripted muxer:
// a cold seek must cancel the running conversion, restart it at the snapped
// keyframe, publish under region-prefixed names, and carry the new offset in
// the publish timeline.
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => {
  class ConversionCanceledError extends Error {}

  interface FakeConversionOpts {
    input: unknown
    output: { opts: { format: { options: Record<string, (...args: never[]) => void> } } }
    trim?: { start: number }
  }

  class FakeConversion {
    static conversions: FakeConversion[] = []
    static async init(opts: FakeConversionOpts): Promise<FakeConversion> {
      const conversion = new FakeConversion(opts)
      FakeConversion.conversions.push(conversion)
      return conversion
    }

    isValid = true
    discardedTracks: { reason: string }[] = []
    onProgress?: (progress: number) => void
    private resolve!: () => void
    private reject!: (error: unknown) => void
    private readonly done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    readonly opts: FakeConversionOpts

    constructor(opts: FakeConversionOpts) {
      this.opts = opts
      // A pending rejection that nobody awaited yet must not kill the run.
      this.done.catch(() => undefined)
    }

    execute(): Promise<void> { return this.done }
    finish(): void { this.resolve() }
    async cancel(): Promise<void> { this.reject(new ConversionCanceledError('canceled')) }
  }

  return { FakeConversion, ConversionCanceledError }
})

const conversions = mocked.FakeConversion.conversions

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BufferTarget: class {},
  CmafOutputFormat: class {},
  Conversion: mocked.FakeConversion,
  ConversionCanceledError: mocked.ConversionCanceledError,
  EncodedPacketSink: class {
    async getKeyPacket(seconds: number) { return { timestamp: Math.floor(seconds) - 2 } }
  },
  HlsOutputFormat: class {
    options: unknown
    constructor(options: unknown) { this.options = options }
  },
  Input: class {},
  Output: class {
    opts: unknown
    constructor(opts: unknown) { this.opts = opts }
  },
  PathedTarget: class {},
  canEncodeAudio: async () => true,
}))
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => undefined }))
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => undefined }))
vi.mock('@mediabunny/aac-encoder', () => ({ registerAacEncoder: () => undefined }))
vi.mock('./mkvChapters', () => ({ readMkvChapters: async () => [] }))

import { runClientRemux, type ClientRemuxHandle } from './clientMedia'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Recorded { url: string; body?: Record<string, unknown> }

function mockServer(): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const record: Recorded = { url }
    if (typeof init?.body === 'string') record.body = JSON.parse(init.body) as Record<string, unknown>
    calls.push(record)
    if (url.endsWith('/client-media/claim')) {
      return { ok: true, json: async () => ({ claim: 'client:t', mediaGeneration: 0, maxBytes: 1 << 30 }) }
    }
    if (url.endsWith('/client-media/presign')) {
      const objects = (record.body!.objects as { name: string }[]).map((object) => ({
        name: object.name, url: `https://bucket/${object.name}`, headers: {},
      }))
      return { ok: true, json: async () => ({ objects }) }
    }
    if (url.endsWith('/client-media/publish')) {
      return { ok: true, json: async () => ({ confirmed: [], ready: true }) }
    }
    // Segment PUTs and the claim release.
    return { ok: true, json: async () => ({}), text: async () => '' }
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  conversions.length = 0
})

describe('client remux regions', () => {
  it('restarts at the snapped keyframe and publishes the region under its own names', async () => {
    const calls = mockServer()
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    const run = runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000 } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()
    expect(conversions).toHaveLength(1)
    expect(conversions[0].opts.trim).toBeUndefined()
    expect(handle).not.toBeNull()

    // The muxer emits region zero's first files under the legacy names.
    const first = conversions[0].opts.output.opts.format.options
    ;(first.onInit as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { n: 0 })
    ;(first.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    await flush()

    // Eighteen minutes in is far past the produced edge: a cold seek.
    handle!.follow(1_080_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(2)
    // Snapped back to the keyframe the fake sink reports, two seconds early.
    expect(conversions[1].opts.trim?.start).toBe(1078)

    const second = conversions[1].opts.output.opts.format.options
    ;(second.onInit as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { n: 0 })
    ;(second.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()

    // Region 1 hits the end of the file: everything before 18:00 is still
    // unproduced, so the pipeline parks. Seeking near zero wakes it into a
    // region that starts at the very beginning...
    conversions[1].finish()
    await flush()
    await flush()
    handle!.follow(500)
    await flush()
    await flush()
    expect(conversions).toHaveLength(3)
    expect(conversions[2].opts.trim).toBeUndefined()

    // ...and a region from zero reaching the end is the whole timeline: the
    // run completes, back on the zero offset.
    conversions[2].finish()
    await run

    const presigned = calls
      .filter((call) => call.url.endsWith('/client-media/presign'))
      .flatMap((call) => (call.body!.objects as { name: string }[]).map((object) => object.name))
    expect(presigned).toContain('cinit_0.mp4')
    expect(presigned).toContain('r1_cinit_0.mp4')
    expect(presigned).toContain('r1_cs_0_1.m4s')

    const publishes = calls.filter((call) => call.url.endsWith('/client-media/publish'))
    const last = publishes[publishes.length - 1].body!
    expect(last.complete).toBe(true)
    expect(last.timeline).toEqual({ durationMs: 1_440_000, offsetMs: 0 })
  })
})

  it('parks at a region end instead of completing, and wakes on the next seek', async () => {
    const calls = mockServer()
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    // Never awaited on purpose: parking forever is this test's point.
    void runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000 } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()

    // Straight to the middle: region 1 starts at the snapped keyframe.
    handle!.follow(1_080_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(2)
    const second = conversions[1].opts.output.opts.format.options
    ;(second.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()

    // The region runs to the end of the file. Everything before 18:00 is
    // still unproduced, so the run must not complete — it parks.
    conversions[1].finish()
    await flush()
    await flush()
    const completes = () => calls.filter((call) =>
      call.url.endsWith('/client-media/publish') && call.body?.complete === true)
    expect(completes()).toHaveLength(0)

    // The next cold seek wakes the loop and re-prepares from the start.
    handle!.follow(30_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(3)
    const third = conversions[2].opts.output.opts.format.options
    ;(third.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    await flush()
    // Region from ~0:28 runs to EOF; still not the whole timeline from zero,
    // so it parks again rather than completing with the head missing.
    conversions[2].finish()
    await flush()
    await flush()
    expect(completes()).toHaveLength(0)
  })
