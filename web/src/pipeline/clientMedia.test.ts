// Drives the region machinery of the client pipeline with a scripted muxer:
// a cold seek must cancel the running conversion, restart it at the snapped
// keyframe, publish under region-prefixed names, and carry the new offset in
// the publish timeline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { endPlaylist, runClientRemux, type ClientRemuxHandle } from './clientMedia'

// Fake timers so the publish ticker can be driven on purpose: a region's
// span is what the server confirmed, and confirmation only happens on a
// publish round.
const flush = async () => { await vi.advanceTimersByTimeAsync(1) }
/** One turn of the publish ticker, which confirms what has been uploaded. */
const publishRound = async () => { await vi.advanceTimersByTimeAsync(2_000) }

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
    ;(first.onInit as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { n: 0 })
    ;(first.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
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
    ;(second.onInit as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { n: 0 })
    ;(second.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    ;(second.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()

    // Region 1 hits the end of the file: everything between region zero's
    // four seconds and 18:00 is still unproduced, so the pipeline parks.
    conversions[1].finish()
    await flush()
    await flush()
    // Seeking back into region zero's produced stretch is covered: the
    // player switches to that region on its own, nothing restarts.
    handle!.follow(500)
    await flush()
    await flush()
    expect(conversions).toHaveLength(2)
    // Past its end is not: a new region continues from there.
    handle!.follow(4_500)
    await flush()
    await flush()
    expect(conversions).toHaveLength(3)
    expect(conversions[2].opts.trim?.start).toBe(2)

    // Region 2 runs to the end; together the regions cover the timeline and
    // the run completes. A region that emitted nothing spans nothing, so it
    // has to produce a segment before it can claim the tail.
    const third = conversions[2].opts.output.opts.format.options
    ;(third.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n: 1 })
    ;(third.onMaster as (c: string) => void)('#EXTM3U\n')
    await flush()
    await publishRound()
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
    expect(last.timeline).toEqual({
      durationMs: 1_440_000,
      offsetMs: 2_000,
      regions: [
        { n: 0, startMs: 0, producedMs: 4_000, growing: false },
        { n: 1, startMs: 1_078_000, producedMs: 1_440_000 - 1_078_000, growing: false },
        { n: 2, startMs: 2_000, producedMs: 1_440_000 - 2_000, growing: false },
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
    const first = conversions[0].opts.output.opts.format.options
    ;(first.onInit as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { n: 0 })
    for (let n = 1; n <= 20; n += 1) {
      ;(first.onSegment as (t: unknown, i: unknown) => void)({ buffer: new ArrayBuffer(4) }, { playlist: { n: 0 }, n })
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
