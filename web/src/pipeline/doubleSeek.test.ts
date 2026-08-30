// Reproduces the frozen producedMs seen in production: region 0 abandoned at
// birth, a far seek (region 1), a seek back to 0 (region 2), and region 2's
// confirmed span must keep growing as its segments land.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => {
  class ConversionCanceledError extends Error {}
  interface FakeConversionOpts {
    input: unknown
    output: { opts: { format: { options: Record<string, (...args: never[]) => void> }; target: { getTarget: (request: { path: string }) => { buffer: ArrayBuffer | null; options?: { onFinalize?: (buffer: ArrayBuffer) => unknown } } } } }
    trim?: { start?: number; end?: number }
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
    private readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    readonly opts: FakeConversionOpts
    constructor(opts: FakeConversionOpts) { this.opts = opts; this.done.catch(() => undefined) }
    execute(): Promise<void> { return this.done }
    finish(): void { this.resolve() }
    async cancel(): Promise<void> { this.reject(new ConversionCanceledError('canceled')) }
  }
  return { FakeConversion, ConversionCanceledError }
})
const conversions = mocked.FakeConversion.conversions

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BufferTarget: class {
    buffer: ArrayBuffer | null = null
    options?: { onFinalize?: (buffer: ArrayBuffer) => unknown }
    constructor(options?: { onFinalize?: (buffer: ArrayBuffer) => unknown }) { this.options = options }
  },
  CmafOutputFormat: class {},
  Conversion: mocked.FakeConversion,
  ConversionCanceledError: mocked.ConversionCanceledError,
  EncodedPacketSink: class {
    async getKeyPacket(seconds: number) { return { timestamp: Math.max(Math.floor(seconds) - 2, 0) } }
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
  PathedTarget: class {
    getTarget: (request: { path: string }) => unknown
    constructor(_root: string, getTarget: (request: { path: string }) => unknown) { this.getTarget = getTarget }
  },
  canEncodeAudio: async () => true,
}))
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => undefined }))
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => undefined }))
vi.mock('@mediabunny/aac-encoder', () => ({ registerAacEncoder: () => undefined }))
vi.mock('./mkvChapters', () => ({ readMkvChapters: async () => [] }))

import { runClientRemux, type ClientRemuxHandle } from './clientMedia'

const flush = async () => { await vi.advanceTimersByTimeAsync(1) }
const publishRound = async () => { await vi.advanceTimersByTimeAsync(2_000) }

interface Recorded { url: string; body?: Record<string, unknown> }

function mockServer(): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const record: Recorded = { url }
    if (typeof init?.body === 'string') record.body = JSON.parse(init.body) as Record<string, unknown>
    calls.push(record)
    if (url.endsWith('/client-media/claim')) {
      return { ok: true, json: async () => ({ claim: 'client:t', mediaGeneration: 0, maxBytes: 1 << 30, metadataToken: 'meta:t' }) }
    }
    if (url.endsWith('/client-media/presign')) {
      const objects = (record.body!.objects as { name: string }[]).map((object) => ({
        name: object.name, url: `https://bucket/${object.name}`, headers: {},
      }))
      return { ok: true, json: async () => ({ objects }) }
    }
    if (url.endsWith('/client-media/publish')) {
      const confirmed = (record.body!.confirm as string[] | undefined) ?? []
      return { ok: true, json: async () => ({ confirmed, ready: true }) }
    }
    return { ok: true, json: async () => ({}), text: async () => '' }
  }))
  return calls
}

const emit = (conversion: (typeof conversions)[number], path: string, info?: { playlist: { n: number }; n: number }): Promise<unknown> => {
  const target = conversion.opts.output.opts.target.getTarget({ path })
  const buffer = new ArrayBuffer(4)
  target.buffer = buffer
  if (info) {
    ;(conversion.opts.output.opts.format.options.onSegment as (t: unknown, i: unknown) => void)(target, info)
  }
  return Promise.resolve(target.options?.onFinalize?.(buffer))
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); conversions.length = 0 })

describe('double seek', () => {
  it('region 2 producedMs keeps growing after seek far then back to zero', async () => {
    const calls = mockServer()
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 2482,
    }
    void runClientRemux({
      roomID: 'r1', mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {}, prefetchAt: () => {} } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()

    // Region 0 barely starts; the user seeks to 1190s immediately.
    handle!.follow(1_190_000)
    await flush(); await flush()
    expect(conversions).toHaveLength(2)
    const first = conversions[1].opts.output.opts.format.options
    ;(first.onPlaylist as (c: string, i: unknown) => void)('#EXTM3U\n#EXTINF:3.5,\nr1_cs_1_1.m4s\n', { n: 1 })
    void emit(conversions[1], 'r1_cinit_1.mp4')
    for (let n = 1; n <= 8; n += 1) void emit(conversions[1], `r1_cs_1_${n}.m4s`, { playlist: { n: 1 }, n })
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()

    // Back near the start: region 2.
    handle!.follow(30_000)
    await flush(); await flush()
    expect(conversions).toHaveLength(3)
    const second = conversions[2].opts.output.opts.format.options
    void emit(conversions[2], 'r2_cinit_1.mp4')
    const playlist = (upTo: number) => `#EXTM3U\n${Array.from({ length: upTo }, (_, i) => `#EXTINF:3.5,\nr2_cs_1_${i + 1}.m4s\n`).join('')}`
    for (let n = 1; n <= 7; n += 1) void emit(conversions[2], `r2_cs_1_${n}.m4s`, { playlist: { n: 1 }, n })
    ;(second.onPlaylist as (c: string, i: unknown) => void)(playlist(7), { n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()
    await publishRound()

    // Production continues: many more segments confirm.
    for (let n = 8; n <= 30; n += 1) void emit(conversions[2], `r2_cs_1_${n}.m4s`, { playlist: { n: 1 }, n })
    ;(second.onPlaylist as (c: string, i: unknown) => void)(playlist(30), { n: 1 })
    await flush()
    await publishRound()
    await publishRound()
    await publishRound()

    const publishes = calls.filter((call) => call.url.endsWith('/client-media/publish') && call.body?.timeline)
    const last = publishes[publishes.length - 1].body!.timeline as { regions: { n: number; producedMs: number; growing: boolean }[] }
    const region2 = last.regions.find((r) => r.n === 2)
    expect(region2).toBeDefined()
    // 30 segments of 3.5s confirmed: the span must reflect them, not the
    // first batch only.
    expect(region2!.producedMs).toBeGreaterThanOrEqual(30 * 3_500)
    conversions[2].finish()
  })
})
