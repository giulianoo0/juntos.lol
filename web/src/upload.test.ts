import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_UNREADABLE,
  SOURCE_UNREACHABLE,
  UNSUPPORTED_MEDIA,
  createRoomAndUpload,
  createRoomAndUploadTorrent,
  isUnreadableFile,
  startUrlUpload,
  subscribeUploadDone,
  subscribeUploadProgress,
  type RoomUploadProgress,
  lastUploadFailureDetail,
} from './upload'

const subtitleFakes = vi.hoisted(() => {
  const written: Uint8Array[] = []
  const published: Array<{ source: string; tracks: Array<{ language: string; title: string; vtt: string }>; complete: boolean }> = []
  return {
    written,
    published,
    reset() {
      written.length = 0
      published.length = 0
    },
    stream: {
      write: (chunk: Uint8Array) => { written.push(chunk) },
      snapshot: () => [{ language: 'eng', title: 'partial', vtt: 'WEBVTT' }],
      finish: async () => [{ language: 'eng', title: 'Signs', vtt: 'WEBVTT' }],
      fonts: () => [],
    },
    collector: {
      register: vi.fn(),
      publish: vi.fn((source: string, tracks: Array<{ language: string; title: string; vtt: string }>, complete: boolean) => {
        published.push({ source, tracks, complete })
      }),
      flush: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('./subtitles', () => ({
  isMatroska: (file: { name: string; type?: string }) => file.name.toLowerCase().endsWith('.mkv'),
  createMatroskaSubtitleStream: vi.fn().mockResolvedValue(subtitleFakes.stream),
  createSubtitleCollector: vi.fn(() => subtitleFakes.collector),
  postSubtitleFonts: vi.fn().mockResolvedValue(undefined),
}))
const clientPipeline = vi.hoisted(() => ({
  planClientRemux: vi.fn(),
  runClientRemux: vi.fn(),
  lastPlanRefusal: vi.fn(() => 'no video track'),
  RoomMovedOnError: class RoomMovedOnError extends Error {},
}))
vi.mock('./pipeline/clientMedia', () => clientPipeline)

const plan = { input: {}, audioTracks: [], durationSeconds: 60 }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('upload registry', () => {
  let roomCounter = 0
  let roomBodies: Array<{ fileName: string; nickname: string }> = []

  beforeEach(() => {
    subtitleFakes.reset()
    roomBodies = []
    roomCounter = 0
    clientPipeline.planClientRemux.mockResolvedValue(plan)
    clientPipeline.runClientRemux.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      roomCounter += 1
      roomBodies.push(JSON.parse(init.body) as { fileName: string; nickname: string })
      return { ok: true, json: async () => ({ id: `room${roomCounter}`, nickname: 'giuli' }) }
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  const startUpload = async (file = new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })) => {
    let finishRun: () => void = () => {}
    let failRun: (error: unknown) => void = () => {}
    let report: (pct: number) => void = () => {}
    clientPipeline.runClientRemux.mockImplementationOnce((options: { onProgress: (pct: number) => void }) => {
      report = options.onProgress
      return new Promise<void>((resolve, reject) => { finishRun = resolve; failRun = reject })
    })
    const result = await createRoomAndUpload(file, 'giuli')
    await vi.waitFor(() => expect(clientPipeline.runClientRemux).toHaveBeenCalledOnce())
    return { result, file, finishRun, failRun, report }
  }

  it('creates the room, then remuxes here: the server never sees a video byte', async () => {
    const { result } = await startUpload()
    expect(result.roomID).toBe('room1')
    expect(roomBodies).toEqual([{ fileName: 'movie.mkv', nickname: 'giuli' }])
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce()
    expect(clientPipeline.runClientRemux.mock.calls[0][0]).toMatchObject({ roomID: 'room1', mediaGeneration: 0 })
  })

  it('reports a source this browser cannot remux, instead of handing it anywhere', async () => {
    clientPipeline.planClientRemux.mockResolvedValueOnce(null)
    const result = await createRoomAndUpload(new File(['video'], 'movie.mkv'), 'giuli')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(UNSUPPORTED_MEDIA))
    expect(clientPipeline.runClientRemux).not.toHaveBeenCalled()
    expect(lastUploadFailureDetail()).toBe('no video track')
  })

  it('reports a remux that died mid-flight', async () => {
    const { result, failRun } = await startUpload()
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    failRun(new Error('encoder exploded'))
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('encoder exploded'))
  })

  it('says nothing when the room was swapped under the run', async () => {
    const { result, failRun } = await startUpload()
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    failRun(new clientPipeline.RoomMovedOnError('swapped'))
    await tick()
    expect(done).not.toHaveBeenCalled()
  })

  it('resolves with the room id before the remux completes', async () => {
    const { result } = await startUpload()
    expect(result.roomID).toBe('room1')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    expect(done).not.toHaveBeenCalled()
  })

  it('fans out progress and replays the latest value to new subscribers', async () => {
    const { result, report } = await startUpload(new File(['video'], 'movie.mkv'))
    const seen: RoomUploadProgress[] = []
    const unsubscribe = subscribeUploadProgress(result.roomID, (progress) => seen.push(progress))
    expect(seen).toEqual([{ pct: 0, bytesUploaded: 0, bytesTotal: 5 }])

    report(40)
    expect(seen.at(-1)).toEqual({ pct: 40, bytesUploaded: 2, bytesTotal: 5 })

    const late: RoomUploadProgress[] = []
    subscribeUploadProgress(result.roomID, (progress) => late.push(progress))
    expect(late).toEqual([seen.at(-1)])

    unsubscribe()
    report(100)
    expect(seen).toHaveLength(2)
    expect(late.at(-1)?.pct).toBe(100)
  })

  it('notifies done subscribers on success and replays to late subscribers', async () => {
    const { result, finishRun } = await startUpload()
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    finishRun()
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(null))

    const late = vi.fn()
    subscribeUploadDone(result.roomID, late)
    expect(late).toHaveBeenCalledWith(null)
  })

  it('evicts the entry from the registry shortly after completion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result, finishRun } = await startUpload()
      const done = vi.fn()
      subscribeUploadDone(result.roomID, done)
      finishRun()
      await vi.waitFor(() => expect(done).toHaveBeenCalledWith(null))

      const withinTtl = vi.fn()
      subscribeUploadDone(result.roomID, withinTtl)
      expect(withinTtl).toHaveBeenCalledWith(null)

      vi.advanceTimersByTime(31_000)
      const afterEviction = vi.fn()
      subscribeUploadDone(result.roomID, afterEviction)
      expect(afterEviction).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores unknown room ids', () => {
    const progress = vi.fn()
    const done = vi.fn()
    subscribeUploadProgress('nope', progress)
    subscribeUploadDone('nope', done)
    expect(progress).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })

  it('parses embedded subtitles out of a sequential pass over the file', async () => {
    const { finishRun } = await startUpload(new File(['matroska bytes'], 'movie.mkv'))
    finishRun()
    await vi.waitFor(() => expect(subtitleFakes.published.at(-1)).toMatchObject({ source: 'embedded', complete: true }))
    expect(subtitleFakes.collector.register).toHaveBeenCalledWith('embedded')
    expect(new TextDecoder().decode(subtitleFakes.written[0])).toBe('matroska bytes')
    expect(subtitleFakes.published.at(-1)?.tracks[0].title).toBe('Signs')
  })

  it('skips the subtitle pass for a container that is not Matroska', async () => {
    const { finishRun } = await startUpload(new File(['mp4 bytes'], 'movie.mp4', { type: 'video/mp4' }))
    finishRun()
    await tick()
    expect(subtitleFakes.collector.register).not.toHaveBeenCalled()
  })

  it('refuses a file that is still being written before any room exists', async () => {
    const file = new File(['video'], 'movie.mkv')
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValueOnce(new DOMException('changed', 'NotReadableError'))
    await expect(createRoomAndUpload(file, 'giuli')).rejects.toThrow(FILE_UNREADABLE)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('recognizes the unreadable-file failure however it arrives', () => {
    expect(isUnreadableFile(new DOMException('x', 'NotReadableError'))).toBe(true)
    expect(isUnreadableFile(new DOMException('x', 'NotFoundError'))).toBe(true)
    expect(isUnreadableFile(new Error(FILE_UNREADABLE))).toBe(true)
    expect(isUnreadableFile(new Error('network down'))).toBe(false)
  })
})

describe('torrent upload', () => {
  const bytes = new TextEncoder().encode('torrent bytes')
  const file = {
    name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: bytes.byteLength,
    type: 'video/x-matroska', progress: 0, downloaded: 0,
    read: vi.fn(async (start: number, end: number) => bytes.slice(start, end + 1).buffer),
  }
  const makeSession = () => ({
    name: 'show', files: [file],
    subtitleFiles: [{
      name: 'episode.srt', path: 'show/episode.srt', size: 30,
      read: vi.fn(async () => new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHi\n').buffer),
    }],
    stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }),
    select: vi.fn(), destroy: vi.fn(),
  })

  beforeEach(() => {
    subtitleFakes.reset()
    file.read.mockClear()
    clientPipeline.planClientRemux.mockResolvedValue(plan)
    clientPipeline.runClientRemux.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'room1', nickname: 'giuli' }) }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('remuxes the torrent from the helper, and publishes both kinds of subtitle', async () => {
    const session = makeSession()
    const result = await createRoomAndUploadTorrent({ file, session }, 'giuli')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(null))

    const input = clientPipeline.runClientRemux.mock.calls[0][0].file as { name: string; size: number }
    expect(input).toMatchObject({ name: 'episode.mkv', size: bytes.byteLength })
    await vi.waitFor(() => expect(subtitleFakes.published.some((entry) => entry.source === 'embedded' && entry.complete)).toBe(true))
    expect(new TextDecoder().decode(subtitleFakes.written[0])).toBe('torrent bytes')
    expect(subtitleFakes.published.some((entry) => entry.source === 'external' && entry.complete)).toBe(true)
    expect(session.destroy).toHaveBeenCalled()
  })

  it('tears the helper session down when the remux fails too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    clientPipeline.runClientRemux.mockRejectedValueOnce(new Error('boom'))
    const session = makeSession()
    const result = await createRoomAndUploadTorrent({ file, session }, 'giuli')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('boom'))
    expect(session.destroy).toHaveBeenCalled()
  })
})

describe('url upload', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('names the source as unreachable when the browser cannot even read it', async () => {
    clientPipeline.planClientRemux.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    startUrlUpload('room9', 0, 'https://cdn.example/movie.mkv', 'movie.mkv', 0)
    const done = vi.fn()
    subscribeUploadDone('room9', done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(SOURCE_UNREACHABLE))
  })
})
