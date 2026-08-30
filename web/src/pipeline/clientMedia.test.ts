// Drives the region machinery of the client pipeline with a scripted muxer:
// a cold seek must cancel the running conversion, restart it at the snapped
// keyframe, publish under region-prefixed names, and carry the new offset in
// the publish timeline.
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
  BufferTarget: class {
    buffer: ArrayBuffer | null = null
    options?: { onFinalize?: (buffer: ArrayBuffer) => unknown }
    constructor(options?: { onFinalize?: (buffer: ArrayBuffer) => unknown }) { this.options = options }
  },
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
  PathedTarget: class {
    getTarget: (request: { path: string }) => unknown
    constructor(_root: string, getTarget: (request: { path: string }) => unknown) { this.getTarget = getTarget }
  },
  canEncodeAudio: async () => true,
}))
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => undefined }))
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => undefined }))
vi.mock('@mediabunny/aac-encoder', () => ({ registerAacEncoder: () => undefined }))
const chaptersMock = vi.hoisted(() => ({
  read: (): Promise<{ startMs: number; endMs: number; title: string }[]> => Promise.resolve([]),
}))
vi.mock('./mkvChapters', () => ({ readMkvChapters: () => chaptersMock.read() }))

import { endPlaylist, runClientRemux, segmentDurations, type ClientRemuxHandle } from './clientMedia'

// Fake timers so the publish ticker can be driven on purpose: a region's
// span is what the server confirmed, and confirmation only happens on a
// publish round.
const flush = async () => { await vi.advanceTimersByTimeAsync(1) }
/** One turn of the publish ticker, which confirms what has been uploaded. */
const publishRound = async () => { await vi.advanceTimersByTimeAsync(2_000) }

// Emits one finished file the way mediabunny does now: the PathedTarget
// hands out a BufferTarget whose awaited onFinalize is the admission gate,
// and segments additionally notify onSegment for the ledger.
const emit = (conversion: (typeof conversions)[number], path: string, info?: { playlist: { n: number }; n: number }): Promise<unknown> => {
  const target = conversion.opts.output.opts.target.getTarget({ path })
  const buffer = new ArrayBuffer(4)
  target.buffer = buffer
  if (info) {
    ;(conversion.opts.output.opts.format.options.onSegment as (t: unknown, i: unknown) => void)(target, info)
  }
  return Promise.resolve(target.options?.onFinalize?.(buffer))
}

interface Recorded { url: string; body?: Record<string, unknown> }

// Segment PUTs the fixture is holding until the test lets them land; an
// aborted one rejects the way a real fetch does.
const heldUploads: (() => void)[] = []
function releaseUploads(): void {
  for (const release of heldUploads.splice(0)) release()
}

function mockServer({ holdUploads = false } = {}): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
    const record: Recorded = { url }
    if (holdUploads && url.startsWith('https://bucket/')) {
      calls.push(record)
      await new Promise<void>((resolve, reject) => {
        heldUploads.push(resolve)
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
      return { ok: true, json: async () => ({}), text: async () => '' }
    }
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
      // A working bucket vouches for what it was handed. Regions span what
      // the server confirmed, so a fixture that confirms nothing would
      // describe a room with nothing playable in it.
      const confirmed = (record.body!.confirm as string[] | undefined) ?? []
      return { ok: true, json: async () => ({ confirmed, ready: true }) }
    }
    // Segment PUTs and the claim release.
    return { ok: true, json: async () => ({}), text: async () => '' }
  }))
  return calls
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
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
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()
    expect(conversions).toHaveLength(1)
    expect(conversions[0].opts.trim).toBeUndefined()
    expect(handle).not.toBeNull()

    // The muxer emits region zero's first files under the legacy names.
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    void emit(conversions[0], 'cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    void first
    await flush()
    // The bucket confirms region zero's segment: only now does it span
    // anything a player could seek into.
    await publishRound()

    // Eighteen minutes in is far past the produced edge: a cold seek.
    handle!.follow(1_080_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(2)
    // Snapped back to the keyframe the fake sink reports, two seconds early.
    expect(conversions[1].opts.trim?.start).toBe(1078)

    const second = conversions[1].opts.output.opts.format.options
    void emit(conversions[1], 'r1_cinit_0.mp4')
    void emit(conversions[1], 'r1_cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()

    // Region 1 hits the end of the file: everything between region zero's
    // four seconds and 18:00 is still unproduced, so the pipeline goes and
    // fills it — a region from the keyframe before the gap, ending a segment
    // past where region 1 begins.
    conversions[1].finish()
    await publishRound()
    await flush()
    expect(conversions).toHaveLength(3)
    expect(conversions[2].opts.trim).toEqual({ start: 2, end: 1_082 })
    // Seeking back into region zero's produced stretch is covered: the
    // player switches to that region on its own, nothing restarts.
    handle!.follow(500)
    await flush()
    await flush()
    expect(conversions).toHaveLength(3)
    // Just past its end is covered too: the fill region is about to be
    // there, so nothing restarts either.
    handle!.follow(4_500)
    await flush()
    await flush()
    expect(conversions).toHaveLength(3)

    // The fill region produces the whole gap; together the regions cover
    // the timeline and the run completes.
    const third = conversions[2].opts.output.opts.format.options
    for (let n = 1; n <= 270; n += 1) {
      void emit(conversions[2], `r2_cs_0_${n}.m4s`, { playlist: { n: 0 }, n })
    }
    ;(third.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()
    await publishRound()
    await publishRound()
    conversions[2].finish()
    await publishRound()
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
    expect(last.timeline).toEqual({
      durationMs: 1_440_000,
      offsetMs: 2_000,
      regions: [
        { n: 0, startMs: 0, producedMs: 4_000, growing: false },
        { n: 1, startMs: 1_078_000, producedMs: 1_440_000 - 1_078_000, growing: false },
        { n: 2, startMs: 2_000, producedMs: 270 * 4_000, growing: false },
      ],
    })
  })
})

  it('goes and produces a seek target the muxer emitted but the bucket never confirmed', async () => {
    mockServer()
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    void runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()

    // The muxer runs far ahead of the uplink — stream-copying a local file
    // outruns a home connection many times over — so twenty segments exist
    // in the queue while the bucket still holds none of them.
    void emit(conversions[0], 'cinit_0.mp4')
    for (let n = 1; n <= 20; n += 1) {
      void emit(conversions[0], `cs_0_${n}.m4s`, { playlist: { n: 0 }, n })
    }
    await flush()

    // A minute in sits well inside the eighty seconds the muxer emitted, so
    // counting emissions would call this covered and leave the player
    // waiting on segments no playlist can reach. Counting what the bucket
    // confirmed sends the pipeline to fetch it.
    handle!.follow(60_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(2)
  })

  it('a seek that lands while the finished region is still uploading does not tear the drain down', async () => {
    const calls = mockServer({ holdUploads: true })
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 634,
    }
    const run = runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan as never,
      onHandle: (h) => { handle = h },
    })
    await flush()
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    for (let n = 1; n <= 6; n += 1) {
      void emit(conversions[0], `cs_0_${n}.m4s`, { playlist: { n: 0 }, n })
    }
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    // The whole file is produced; only the tail of the uploads is left.
    conversions[0].finish()
    await flush()
    await flush()

    // A seek now has nowhere to restart. Restarting anyway aborted the
    // uploads still in flight, which left the region's producedMs short of
    // the end and the seek's target uncovered for good.
    handle!.follow(503_000)
    await flush()
    releaseUploads()
    await flush()
    await publishRound()
    await flush()
    await run
    expect(conversions).toHaveLength(1)
    const completes = calls.filter((call) =>
      call.url.endsWith('/client-media/publish') && call.body?.complete === true)
    expect(completes).toHaveLength(1)
    expect((completes[0].body!.timeline as { regions: unknown[] }).regions).toEqual([{ n: 0, startMs: 0, producedMs: 634_000, growing: false }])
  })

  it('fills the gaps behind a region instead of parking, and a seek still wins', async () => {
    const calls = mockServer()
    let handle: ClientRemuxHandle | null = null
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    // Never awaited on purpose: the run only completes once every gap is
    // filled, and this test stops well before that.
    void runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
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
    void emit(conversions[1], 'r1_cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()

    // The region runs to the end of the file. Everything before 18:00 is
    // still unproduced, so the run must not complete — it goes and fills
    // the head, bounded a segment past where region 1 begins.
    conversions[1].finish()
    await publishRound()
    await flush()
    const completes = () => calls.filter((call) =>
      call.url.endsWith('/client-media/publish') && call.body?.complete === true)
    expect(completes()).toHaveLength(0)
    expect(conversions).toHaveLength(3)
    expect(conversions[2].opts.trim).toEqual({ end: 1_082 })

    // A cold seek during the fill is a seek like any other: the fill region
    // dies and the new one starts at the target.
    handle!.follow(200_000)
    await flush()
    await flush()
    expect(conversions).toHaveLength(4)
    expect(conversions[3].opts.trim).toEqual({ start: 198 })
    void emit(conversions[3], 'r3_cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    await flush()
    // Region 3 runs to EOF; the head is still missing, so the next fill goes
    // back for it — this time up to where region 3 starts.
    conversions[3].finish()
    await publishRound()
    await flush()
    expect(completes()).toHaveLength(0)
    expect(conversions).toHaveLength(5)
    expect(conversions[4].opts.trim).toEqual({ end: 202 })
  })

describe('publish on demand', () => {
  it('publishes the first segment of a region as soon as it lands, without waiting for the ticker', async () => {
    const calls = mockServer()
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    void runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan as never,
    })
    await flush()
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    void emit(conversions[0], 'cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(first.onPlaylist as (c: string, i: unknown) => void)('#EXTM3U\n#EXTINF:10.000,\ncs_0_1.m4s\n', { n: 0 })
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    const before = calls.filter((call) => call.url.endsWith('/client-media/publish')).length
    expect(before).toBe(0)
    // Well inside the two-second ticker: the upload itself kicked the round.
    await vi.advanceTimersByTimeAsync(300)
    const publishes = calls.filter((call) => call.url.endsWith('/client-media/publish'))
    expect(publishes).toHaveLength(1)
    expect(publishes[0].body!.confirm).toEqual(expect.arrayContaining(['cinit_0.mp4', 'cs_0_1.m4s']))
    // The ticker is still the floor for what nobody kicks.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.filter((call) => call.url.endsWith('/client-media/publish')).length).toBeGreaterThan(1)
    // The region spans the ten seconds the playlist declares, not four.
    const last = calls.filter((call) => call.url.endsWith('/client-media/publish')).at(-1)!.body!
    expect((last.timeline as { regions: { producedMs: number }[] }).regions[0].producedMs).toBe(10_000)
    conversions[0].finish()
  })
})

describe('region warm signal', () => {
  it('says a region is warm once, when the bucket vouches for its first segment', async () => {
    mockServer()
    const warm = vi.fn()
    const plan = {
      input: { getPrimaryVideoTrack: async () => ({}) },
      audioTracks: [],
      durationSeconds: 1440,
    }
    void runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan as never,
      onRegionWarm: warm,
    })
    await flush()
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    await flush()
    await vi.advanceTimersByTimeAsync(300)
    // The init alone is not a warm region.
    expect(warm).not.toHaveBeenCalled()
    void emit(conversions[0], 'cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await vi.advanceTimersByTimeAsync(300)
    expect(warm).toHaveBeenCalledTimes(1)
    void emit(conversions[0], 'cs_0_2.m4s', { playlist: { n: 0 }, n: 2 })
    await flush()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(warm).toHaveBeenCalledTimes(1)
    conversions[0].finish()
  })
})


describe('admission and drain', () => {
  const plan = () => ({
    input: { getPrimaryVideoTrack: async () => ({}) },
    audioTracks: [],
    durationSeconds: 1440,
  })

  it('never holds more PUTs in flight than the global ceiling', async () => {
    const calls = mockServer({ holdUploads: true })
    const run = runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan() as never,
    })
    await flush()
    // Forty finished files land at once — the reproduction that used to put
    // 1,024 objects in flight.
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    for (let n = 1; n <= 40; n += 1) {
      void emit(conversions[0], `cs_0_${n}.m4s`, { playlist: { n: 0 }, n })
    }
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await flush()
    const inFlight = calls.filter((call) => call.url.startsWith('https://bucket/')).length
    expect(inFlight).toBeGreaterThan(0)
    expect(inFlight).toBeLessThanOrEqual(8)
    // The run must not leak into the next test: everything is released and
    // the run driven to its end.
    conversions[0].finish()
    for (let round = 0; round < 12; round += 1) {
      releaseUploads()
      await flush()
      await publishRound()
    }
    await run
  })

  it('does not send complete while uploads are still pending', async () => {
    const calls = mockServer({ holdUploads: true })
    const run = runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan() as never,
    })
    await flush()
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    void emit(conversions[0], 'cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    conversions[0].finish()
    await flush()
    await publishRound()
    // The producer is done, but the tail is still uploading: complete must
    // not have gone out.
    const completes = () => calls.filter((call) =>
      call.url.endsWith('/client-media/publish') && call.body?.complete === true)
    expect(completes()).toHaveLength(0)
    releaseUploads()
    await flush()
    await publishRound()
    await flush()
    await run
    expect(completes()).toHaveLength(1)
    // And when it went, nothing was pending: every uploaded name had been
    // offered for confirmation before or at the complete pass.
    const puts = calls.filter((call) => call.url.startsWith('https://bucket/')).length
    const confirmed = calls
      .filter((call) => call.url.endsWith('/client-media/publish'))
      .flatMap((call) => (call.body?.confirm as string[] | undefined) ?? [])
    expect(new Set(confirmed).size).toBe(puts)
  })

  it('publishes media without waiting for chapters, and posts them late through the metadata protocol', async () => {
    let releaseChapters: (chapters: { startMs: number; endMs: number; title: string }[]) => void = () => {}
    chaptersMock.read = () => new Promise((resolve) => { releaseChapters = resolve })
    const calls = mockServer()
    const run = runClientRemux({
      roomID: 'r1',
      mediaGeneration: 0,
      file: { size: 1000, abortReads: () => {} } as never,
      plan: plan() as never,
    })
    await flush()
    const first = conversions[0].opts.output.opts.format.options
    void emit(conversions[0], 'cinit_0.mp4')
    void emit(conversions[0], 'cs_0_1.m4s', { playlist: { n: 0 }, n: 1 })
    ;(first.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()
    // Chapters are still stuck in a cold read; the media published anyway.
    expect(calls.filter((call) => call.url.endsWith('/client-media/publish')).length).toBeGreaterThan(0)
    conversions[0].finish()
    await publishRound()
    await flush()
    // Complete does not wait for them either.
    await run
    expect(calls.filter((call) => call.url.endsWith('/client-media/publish') && call.body?.complete === true)).toHaveLength(1)
    expect(calls.some((call) => call.url.endsWith('/client-media/metadata'))).toBe(false)

    // They surface after the claim died — and still land, through the token.
    releaseChapters([{ startMs: 0, endMs: 90_000, title: 'Opening' }])
    await flush()
    await flush()
    const metadata = calls.filter((call) => call.url.endsWith('/client-media/metadata'))
    expect(metadata).toHaveLength(1)
    expect(metadata[0].body).toMatchObject({
      token: 'meta:t',
      mediaGeneration: 0,
      chapters: [{ startMs: 0, endMs: 90_000, title: 'Opening' }],
    })
    chaptersMock.read = () => Promise.resolve([])
  })
})

describe('segmentDurations', () => {
  it('reads EXTINF in playlist order', () => {
    expect(segmentDurations('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\ncs_0_1.m4s\n#EXTINF:9.5,\ncs_0_2.m4s\n')).toEqual([4, 9.5])
  })
})

describe('endPlaylist', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="r1_cinit_0.mp4"',
    '#EXTINF:2.0,',
    'r1_cs_0_1.m4s',
    '#EXTINF:2.0,',
    'r1_cs_0_2.m4s',
    '#EXTINF:2.0,',
    'r1_cs_0_3.m4s',
    '',
  ].join('\n')

  it('ends the playlist at what the bucket vouches for', () => {
    // A region a seek abandoned names segments whose upload was dropped
    // mid-queue. Sent whole, the server cuts at the first it cannot reach and
    // throws the end marker away with the tail.
    const out = endPlaylist(body, 2)
    expect(out).not.toBeNull()
    expect(out).toContain('r1_cs_0_2.m4s')
    expect(out).not.toContain('r1_cs_0_3.m4s')
    expect(out?.endsWith('#EXT-X-ENDLIST\n')).toBe(true)
    // The header survives, and the tags of the segment that was cut do not.
    expect(out).toContain('#EXT-X-MAP:URI="r1_cinit_0.mp4"')
    expect((out?.match(/#EXTINF/g) ?? []).length).toBe(2)
  })

  it('keeps the whole playlist when everything landed', () => {
    const out = endPlaylist(body, 3)
    expect((out?.match(/#EXTINF/g) ?? []).length).toBe(3)
    expect(out).toContain('r1_cs_0_3.m4s')
  })

  it('is nothing at all when no segment landed', () => {
    // Not a finished region — an empty one, and an empty playlist ending is
    // a viewer told the region is over before it began.
    expect(endPlaylist(body, 0)).toBeNull()
  })
})
