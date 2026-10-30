import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_UNREADABLE,
  REMUX_UNAVAILABLE,
  SOURCE_UNREACHABLE,
  UNSUPPORTED_MEDIA,
  changeRoomSource,
  createRoomAndUpload,
  createRoomAndUploadTorrent,
  sourceKindFor,
  torrentCopy,
  youtubeCopy,
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
  let roomBodies: Array<Record<string, unknown>> = []
  let sourceBodies: Array<Record<string, unknown>> = []

  beforeEach(() => {
    subtitleFakes.reset()
    roomBodies = []
    sourceBodies = []
    roomCounter = 0
    clientPipeline.planClientRemux.mockResolvedValue(plan)
    clientPipeline.runClientRemux.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (url === '/api/rooms') {
        roomCounter += 1
        roomBodies.push(body)
        return { ok: true, json: async () => ({ id: `room${roomCounter}`, nickname: 'giuli', ownerToken: 'own' }) }
      }
      sourceBodies.push({ url, ...body })
      return { ok: true, json: async () => ({ status: 'uploading', fileName: body.fileName, mediaGeneration: 1 }) }
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

  it('creates an empty room, opens the file in it, then remuxes here: the server never sees a video byte', async () => {
    const { result } = await startUpload()
    expect(result.roomID).toBe('room1')
    expect(roomBodies).toEqual([{ nickname: 'giuli' }])
    expect(sourceBodies).toEqual([{ url: '/api/rooms/room1/source', ownerToken: 'own', kind: 'upload', fileName: 'movie.mkv' }])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    expect(clientPipeline.runClientRemux.mock.calls[0][0]).toMatchObject({ roomID: 'room1', mediaGeneration: 1 })
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
  const grant = { jobId: 'j1', readBase: 'https://w.test', ticket: 'T1', expiresAt: new Date(Date.now() + 60_000).toISOString(), name: 'episode.mkv', size: 4_000, fileIndex: 0 }
  const file = {
    name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 4_000,
    type: 'video/x-matroska', progress: 0, downloaded: 0, worker: grant,
  }
  const makeSession = () => ({
    name: 'show', jobId: 'j1', files: [file],
    subtitleFiles: [{ name: 'episode.srt', path: 'show/episode.srt', size: 30, index: 1 }],
    stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }),
    select: vi.fn(), destroy: vi.fn(), detach: vi.fn(),
  })
  const stubFetch = (remux: { status: number; body: unknown }) => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/rooms') return { ok: true, status: 200, json: async () => ({ id: 'room1', nickname: 'giuli', ownerToken: 'own' }) }
      if (url === '/api/rooms/room1/source') return { ok: true, status: 200, json: async () => ({ status: 'uploading', fileName: 'episode.mkv', mediaGeneration: 1 }) }
      if (url === '/api/torrents/j1/remux') return { ok: remux.status < 300, status: remux.status, json: async () => remux.body }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(() => {
    subtitleFakes.reset()
    clientPipeline.planClientRemux.mockResolvedValue(plan)
    clientPipeline.runClientRemux.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('hands the torrent to the fleet and never remuxes it here', async () => {
    const fetchMock = stubFetch({ status: 202, body: { runId: 'run1', state: 'queued' } })
    const session = makeSession()
    const result = await createRoomAndUploadTorrent({ file, session }, 'giuli')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(null))

    const remux = fetchMock.mock.calls.find(([url]) => String(url) === '/api/torrents/j1/remux')
    expect(remux).toBeDefined()
    expect(JSON.parse(String(remux![1]?.body))).toMatchObject({ roomId: 'room1', mediaGeneration: 1, auth: { ownerToken: 'own' } })
    expect(clientPipeline.planClientRemux).not.toHaveBeenCalled()
    expect(clientPipeline.runClientRemux).not.toHaveBeenCalled()
    expect(session.detach).toHaveBeenCalled()
    expect(session.destroy).not.toHaveBeenCalled()
  })

  it('reports the fleet saying no as the room failing, and releases the session', async () => {
    stubFetch({ status: 503, body: { error: 'remux_unavailable' } })
    const session = makeSession()
    const result = await createRoomAndUploadTorrent({ file, session }, 'giuli')
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(REMUX_UNAVAILABLE))
    expect(lastUploadFailureDetail()).toContain('remux_unavailable')
    expect(clientPipeline.runClientRemux).not.toHaveBeenCalled()
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

describe('a local source', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens the room as local with its title and duration, and only app sources are local', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'local', fileName: 'Filme', mediaGeneration: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await changeRoomSource('ROOM1', 'm1', 'cap', 'local', 'Filme', 600000)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ memberId: 'm1', capability: 'cap', kind: 'local', fileName: 'Filme', title: 'Filme', durationMs: 600000 })
    expect(sourceKindFor('desktop', 'upload')).toBe('local')
    expect(sourceKindFor('fleet', 'youtube')).toBe('youtube')
  })

  it('carries what the other apps open, and never on a source the server holds', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'local', fileName: 'Filme', mediaGeneration: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const copy = { kind: 'torrent' as const, magnet: 'magnet:?xt=urn:btih:abc&dn=Ma%C3%A7%C3%A3', index: 0 }
    await changeRoomSource('ROOM1', 'm1', 'cap', 'local', 'Maçã', undefined, copy)
    await changeRoomSource('ROOM1', 'm1', 'cap', 'upload', 'Maçã', undefined, copy)
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)))
    expect(bodies[0]).toEqual({ memberId: 'm1', capability: 'cap', kind: 'local', fileName: 'Maçã', title: 'Maçã', localCopy: copy })
    expect(bodies[1]).toEqual({ memberId: 'm1', capability: 'cap', kind: 'upload', fileName: 'Maçã' })
  })

  it('names the copy only for a source the app holds', () => {
    const file = { name: 'b.mkv', path: 'Show/b.mkv', index: 3, size: 1, type: '', progress: 0, downloaded: 0 }
    const session = { name: 'Show', magnet: 'magnet:?xt=urn:btih:abc', backend: 'desktop' as const, files: [file], subtitleFiles: [], stats: () => ({ peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }), select: async () => undefined, destroy: () => undefined }
    expect(torrentCopy(session, file)).toEqual({ kind: 'torrent', magnet: 'magnet:?xt=urn:btih:abc', index: 3 })
    expect(torrentCopy({ ...session, backend: 'fleet' }, file)).toBeUndefined()
    expect(torrentCopy({ ...session, magnet: undefined }, file)).toBeUndefined()

    const video = { url: 'https://www.youtube.com/watch?v=x1', videoId: 'x1', backend: 'desktop' as const, summary: { title: 'Clipe', durationMs: 1, live: false }, destroy: () => undefined }
    expect(youtubeCopy(video as never)).toEqual({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=x1', videoId: 'x1' })
    expect(youtubeCopy({ ...video, backend: 'fleet' } as never)).toBeUndefined()
    expect(youtubeCopy({ ...video, videoId: '' } as never)).toBeUndefined()
  })
})
