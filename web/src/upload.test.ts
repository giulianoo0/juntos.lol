import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_UNREADABLE, createRoomAndUpload, createRoomAndUploadTorrent, isUnreadableFile, startTorrentTransfer, startUrlTransfer, subscribeUploadDone, subscribeUploadProgress, type RoomUploadProgress } from './upload'
import { convertMp4ToMkv } from './convert'
import { createMatroskaSubtitleStream, extractAndUploadSubtitles } from './subtitles'

type Handler = (...args: never[]) => void

const FakeUppy = vi.hoisted(() => class {
  static instances: Array<InstanceType<typeof FakeUppy>> = []
  handlers = new Map<string, Handler[]>()
  upload = vi.fn().mockResolvedValue(undefined)
  destroy = vi.fn()
  addFile = vi.fn()
  constructor() { FakeUppy.instances.push(this) }
  use() { return this }
  setMeta() { return this }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  emit(event: string, ...args: never[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
})

vi.mock('@uppy/core', () => ({ default: FakeUppy }))
vi.mock('@uppy/tus', () => ({ default: class {} }))
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
  extractAndUploadSubtitles: vi.fn().mockResolvedValue(undefined),
  isMatroska: (file: { name: string; type?: string }) => file.name.toLowerCase().endsWith('.mkv'),
  createMatroskaSubtitleStream: vi.fn().mockResolvedValue(subtitleFakes.stream),
  createSubtitleCollector: vi.fn(() => subtitleFakes.collector),
}))
vi.mock('./convert', () => ({
  isMp4: vi.fn((file: File) => file.type === 'video/mp4' || /\.(mp4|m4v)$/i.test(file.name)),
  convertMp4ToMkv: vi.fn(),
}))
const clientPipeline = vi.hoisted(() => ({
  planClientRemux: vi.fn().mockResolvedValue(null),
  runClientRemux: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./pipeline/clientMedia', () => clientPipeline)

describe('upload registry', () => {
  let roomCounter = 0
  let roomBodies: Array<{ fileName: string; nickname: string }> = []

  beforeEach(() => {
    FakeUppy.instances = []
    subtitleFakes.reset()
    roomBodies = []
    roomCounter = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      roomCounter += 1
      roomBodies.push(JSON.parse(init.body) as { fileName: string; nickname: string })
      return {
        ok: true,
        json: async () => ({ id: `room${roomCounter}`, nickname: 'giuli', uploadEndpoint: '/api/upload/x', streamStartBytes: 1_048_576 }),
      }
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const startUpload = async (file = new File(['video'], 'movie.mkv', { type: 'video/x-matroska' }), onProgress?: (progress: { phase: string; pct: number }) => void) => {
    const result = await createRoomAndUpload(file, 'giuli', onProgress)
    // The dispatch asks the client pipeline first (asynchronously); with no
    // plan, tus takes over one tick later.
    await vi.waitFor(() => { if (FakeUppy.instances.length === 0) throw new Error('tus not started yet') })
    const uppy = FakeUppy.instances[0]
    return { result, uppy, file }
  }

  it('lets a capable browser prepare the room itself, with no tus at all', async () => {
    clientPipeline.planClientRemux.mockResolvedValueOnce({ input: {}, audioTracks: [], durationSeconds: 60 })
    let resolveRun: () => void = () => {}
    clientPipeline.runClientRemux.mockReturnValueOnce(new Promise<void>((resolve) => { resolveRun = resolve }))

    const result = await createRoomAndUpload(new File(['video'], 'movie.mkv'), 'giuli')
    await vi.waitFor(() => expect(clientPipeline.runClientRemux).toHaveBeenCalledOnce())
    resolveRun()
    await vi.waitFor(() => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(result.roomID).toBe('room1')
    expect(FakeUppy.instances).toHaveLength(0)
  })

  it('falls back to tus when the client pipeline dies mid-flight', async () => {
    clientPipeline.planClientRemux.mockResolvedValueOnce({ input: {}, audioTracks: [], durationSeconds: 60 })
    clientPipeline.runClientRemux.mockRejectedValueOnce(new Error('encoder exploded'))

    await createRoomAndUpload(new File(['video'], 'movie.mkv'), 'giuli')

    // The room is exactly as it was, and tus carries it from zero.
    await vi.waitFor(() => { if (FakeUppy.instances.length === 0) throw new Error('tus not started yet') })
    expect(FakeUppy.instances[0].upload).toHaveBeenCalledOnce()
  })

  it('resolves with the room id before the upload completes', async () => {
    const { result, uppy } = await startUpload()
    expect(result.roomID).toBe('room1')
    expect(uppy.upload).toHaveBeenCalledOnce()
    expect(uppy.destroy).not.toHaveBeenCalled()
  })

  it('fans out progress and replays the latest value to new subscribers', async () => {
    const { result, uppy } = await startUpload()
    const seen: RoomUploadProgress[] = []
    const unsubscribe = subscribeUploadProgress(result.roomID, (progress) => seen.push(progress))
    expect(seen).toEqual([{
      pct: 0,
      bytesUploaded: 0,
      bytesTotal: 5,
      streamStartBytes: 1_048_576,
    }])

    uppy.emit('upload-progress', {} as never, { bytesUploaded: 25, bytesTotal: 100 } as never)
    expect(seen.at(-1)).toEqual({
      pct: 25,
      bytesUploaded: 25,
      bytesTotal: 100,
      streamStartBytes: 1_048_576,
    })

    const late: RoomUploadProgress[] = []
    subscribeUploadProgress(result.roomID, (progress) => late.push(progress))
    expect(late).toEqual([seen.at(-1)])

    unsubscribe()
    uppy.emit('upload-progress', {} as never, { bytesUploaded: 50, bytesTotal: 100 } as never)
    expect(seen).toHaveLength(2)
    expect(late.at(-1)?.pct).toBe(50)
  })

  it('notifies done subscribers on success and replays to late subscribers', async () => {
    const { result, uppy } = await startUpload()
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    uppy.emit('complete', { failed: [] } as never)

    expect(done).toHaveBeenCalledWith(null)
    expect(uppy.destroy).toHaveBeenCalledOnce()

    const late = vi.fn()
    subscribeUploadDone(result.roomID, late)
    expect(late).toHaveBeenCalledWith(null)
  })

  it('reports failures through the done subscription', async () => {
    const { result, uppy } = await startUpload()
    const done = vi.fn()
    subscribeUploadDone(result.roomID, done)
    uppy.emit('complete', { failed: [{}] } as never)
    expect(done).toHaveBeenCalledWith('upload failed')
  })

  it('evicts the entry from the registry shortly after completion', async () => {
    vi.useFakeTimers()
    try {
      const { result, uppy } = await startUpload()
      uppy.emit('complete', { failed: [] } as never)

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

  it('converts mp4 files to mkv before creating the room', async () => {
    const converted = new File(['mkv'], 'movie.mkv', { type: 'video/x-matroska' })
    vi.mocked(convertMp4ToMkv).mockImplementation(async (_file, onProgress) => {
      onProgress?.(50)
      return converted
    })
    const seen: Array<{ phase: string; pct: number }> = []
    const { result, uppy } = await startUpload(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), (p) => seen.push(p))

    expect(roomBodies[0].fileName).toBe('movie.mkv')
    expect(uppy.addFile).toHaveBeenCalledWith({ name: 'movie.mkv', type: 'video/x-matroska', data: converted })
    expect(extractAndUploadSubtitles).toHaveBeenCalledWith(converted, result.roomID, 0)
    expect(seen).toEqual([{ phase: 'converting', pct: 50 }])
  })

  it('uploads the original mp4 unchanged when conversion fails', async () => {
    vi.mocked(convertMp4ToMkv).mockResolvedValue(null)
    const { result, uppy, file } = await startUpload(new File(['video'], 'movie.mp4', { type: 'video/mp4' }))

    expect(roomBodies[0].fileName).toBe('movie.mp4')
    expect(uppy.addFile).toHaveBeenCalledWith({ name: 'movie.mp4', type: 'video/mp4', data: file })
    expect(extractAndUploadSubtitles).toHaveBeenCalledWith(file, result.roomID, 0)
  })

  it('rejects without creating a room when the mp4 has no video track', async () => {
    vi.mocked(convertMp4ToMkv).mockRejectedValue(new Error('no video track'))
    await expect(createRoomAndUpload(new File(['x'], 'audio.mp4', { type: 'video/mp4' }), 'giuli')).rejects.toThrow('no video track')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not convert non-mp4 files', async () => {
    await startUpload()
    expect(convertMp4ToMkv).not.toHaveBeenCalled()
  })

  it('streams a torrent file through tus, starting with the preview threshold', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'torrent-room', nickname: 'giuli', uploadEndpoint: '/api/upload/', streamStartBytes: 2 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ Location: '/api/upload/torrent-id' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': '2' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': '6' }),
      } as Response)

    const read = vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1))
    const destroy = vi.fn()
    const result = await createRoomAndUploadTorrent({
      file: { name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 6, type: 'video/x-matroska', progress: 0, downloaded: 0, read },
      session: { name: 'show', files: [], subtitleFiles: [], stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }), select: vi.fn(), destroy },
    }, 'giuli')
    const done = new Promise<string | null>((resolve) => subscribeUploadDone(result.roomID, resolve))

    await expect(done).resolves.toBeNull()
    expect(read.mock.calls).toEqual([[0, 1], [2, 5]])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'Upload-Length': '6' }),
    })
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'Upload-Offset': '0' }) })
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'Upload-Offset': '2' }) })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('prefetches the next torrent chunk while the current PATCH is in flight', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    let resolveFirstPatch!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'pipe-room', nickname: 'giuli', uploadEndpoint: '/api/upload/', streamStartBytes: 2 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, headers: new Headers({ Location: '/api/upload/pipe-id' }),
      } as Response)
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirstPatch = resolve }))
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '6' }) } as Response)

    const read = vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1))
    const result = await createRoomAndUploadTorrent({
      file: { name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 6, type: 'video/x-matroska', progress: 0, downloaded: 0, read },
      session: { name: 'show', files: [], subtitleFiles: [], stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }), select: vi.fn(), destroy: vi.fn() },
    }, 'giuli')
    const done = new Promise<string | null>((resolve) => subscribeUploadDone(result.roomID, resolve))

    // The read for the second chunk goes out while the first PATCH is still
    // unresolved, and no second PATCH is issued before it settles.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(read.mock.calls).toEqual([[0, 1], [2, 5]])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    resolveFirstPatch({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '2' }) } as Response)
    await expect(done).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('discards a prefetched chunk when a short write moves the offset behind it', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'short-room', nickname: 'giuli', uploadEndpoint: '/api/upload/', streamStartBytes: 4 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, headers: new Headers({ Location: '/api/upload/short-id' }),
      } as Response)
      // The server accepts only 2 of the 4 bytes sent.
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '2' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '6' }) } as Response)

    const read = vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1))
    const result = await createRoomAndUploadTorrent({
      file: { name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 6, type: 'video/x-matroska', progress: 0, downloaded: 0, read },
      session: { name: 'show', files: [], subtitleFiles: [], stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }), select: vi.fn(), destroy: vi.fn() },
    }, 'giuli')
    await new Promise<string | null>((resolve) => subscribeUploadDone(result.roomID, resolve))

    // The prefetch at offset 4 was invalidated by the short write and replaced
    // with a fresh read from the server's authoritative offset.
    expect(read.mock.calls).toEqual([[0, 3], [4, 5], [2, 5]])
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'Upload-Offset': '0' }) })
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'Upload-Offset': '2' }) })
    // The parser sees only the accepted bytes, in order, exactly once.
    expect(subtitleFakes.written.map((chunk) => chunk.byteLength)).toEqual([2, 4])
  })

  it('parses subtitles out of the torrent bytes it is already uploading', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'sub-room', nickname: 'giuli', uploadEndpoint: '/api/upload/', streamStartBytes: 2 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, headers: new Headers({ Location: '/api/upload/sub-id' }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '2' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '6' }) } as Response)

    const read = vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1))
    const result = await createRoomAndUploadTorrent({
      file: { name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 6, type: 'video/x-matroska', progress: 0, downloaded: 0, read },
      session: { name: 'show', files: [], subtitleFiles: [], stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }), select: vi.fn(), destroy: vi.fn() },
    }, 'giuli')
    await new Promise<string | null>((resolve) => subscribeUploadDone(result.roomID, resolve))

    // Every uploaded byte reaches the parser exactly once: no second pass over
    // the swarm is needed to read the muxed subtitle tracks.
    expect(subtitleFakes.written.map((chunk) => chunk.byteLength)).toEqual([2, 4])
    expect(createMatroskaSubtitleStream).toHaveBeenCalled()
    expect(subtitleFakes.published).toContainEqual({
      source: 'embedded',
      tracks: [{ language: 'eng', title: 'Signs', vtt: 'WEBVTT' }],
      complete: true,
    })
  })

  it('publishes the subtitle files shipped next to the video in the torrent', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'ext-room', nickname: 'giuli', uploadEndpoint: '/api/upload/', streamStartBytes: 4 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, headers: new Headers({ Location: '/api/upload/ext-id' }),
      } as Response)
      .mockResolvedValue({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '4' }) } as Response)

    const srt = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nOi\n')
    const subtitleRead = vi.fn().mockResolvedValue(srt.buffer)
    const result = await createRoomAndUploadTorrent({
      file: { name: 'episode.mp4', path: 'show/episode.mp4', index: 0, size: 4, type: 'video/mp4', progress: 0, downloaded: 0, read: vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1)) },
      session: {
        name: 'show',
        files: [],
        subtitleFiles: [{ name: 'Portuguese.srt', path: 'show/Subs/Portuguese.srt', size: srt.byteLength, read: subtitleRead }],
        stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }),
        select: vi.fn(),
        destroy: vi.fn(),
      },
    }, 'giuli')
    await new Promise<string | null>((resolve) => subscribeUploadDone(result.roomID, resolve))
    await vi.waitFor(() => expect(subtitleFakes.published.some((entry) => entry.complete)).toBe(true))

    expect(subtitleRead).toHaveBeenCalledOnce()
    // An MP4 has no client-side parser, so "external" is the only source and
    // its completion is what marks the room done.
    expect(createMatroskaSubtitleStream).not.toHaveBeenCalled()
    expect(subtitleFakes.published.at(-1)).toEqual({
      source: 'external',
      tracks: [{ language: 'por', title: 'Portuguese', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:-3\nOi\n' }],
      complete: true,
    })
  })

  it('refuses a file that is still being written before any room exists', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockReset()
    // A File whose bytes changed on disk: every read throws, which is exactly
    // what a browser does for a download still in progress.
    const file = new File(['partial'], 'still-downloading.mkv', { type: 'video/x-matroska' })
    Object.defineProperty(file, 'slice', {
      configurable: true,
      value: () => ({
        arrayBuffer: () => Promise.reject(new DOMException('changed on disk', 'NotReadableError')),
      }),
    })

    await expect(createRoomAndUpload(file, 'giuli')).rejects.toThrow(FILE_UNREADABLE)
    // Nothing was created, so no room is left sitting at zero per cent.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recognizes the unreadable-file failure however it arrives', () => {
    expect(isUnreadableFile(new DOMException('x', 'NotReadableError'))).toBe(true)
    expect(isUnreadableFile(new DOMException('x', 'NotFoundError'))).toBe(true)
    expect(isUnreadableFile(new Error(FILE_UNREADABLE))).toBe(true)
    expect(isUnreadableFile(new Error('network down'))).toBe(false)
  })
})

describe('torrent handover', () => {
  const file = {
    name: 'episode.mkv', path: 'show/episode.mkv', index: 0, size: 6,
    type: 'video/x-matroska', progress: 0, downloaded: 0,
    read: vi.fn(async (start: number, end: number) => new ArrayBuffer(end - start + 1)),
  }
  const session = (bridgeSessionID?: string) => ({
    name: 'show', files: [], subtitleFiles: [], bridgeSessionID,
    stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }),
    select: vi.fn(), destroy: vi.fn(),
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    file.read.mockClear()
  })

  it('asks the server to pull the file, so the bytes never come through here', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) } as Response)
    const torrent = session('session-1')

    await startTorrentTransfer('room1', '/api/upload/', 1024, 0, { file, session: torrent })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/rooms/room1/torrent')
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'session-1', path: 'show/episode.mkv', fileName: 'episode.mkv', size: 6,
    })
    // Not one byte was read locally.
    expect(file.read).not.toHaveBeenCalled()
    // The session outlives this tab: the server is streaming from it now.
    expect(torrent.destroy).toHaveBeenCalledWith(true)
  })

  it('uploads from here when there is no bridge session to hand over', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, headers: new Headers({ Location: '/api/upload/x' }) } as Response)
      .mockResolvedValue({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '6' }) } as Response)

    await startTorrentTransfer('room1', '/api/upload/', 1024, 0, { file, session: session(undefined) })

    // Straight to tus creation: no handover was attempted at all.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload/')
  })

  it('uploads from here when the server has no ingest route', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, headers: new Headers({ Location: '/api/upload/x' }) } as Response)
      .mockResolvedValue({ ok: true, status: 204, headers: new Headers({ 'Upload-Offset': '6' }) } as Response)

    await startTorrentTransfer('room1', '/api/upload/', 1024, 0, { file, session: session('session-1') })

    expect(fetchMock.mock.calls[1][0]).toBe('/api/upload/')
  })

  it('surfaces a handover the server actually rejected', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409 } as Response)

    await expect(startTorrentTransfer('room1', '/api/upload/', 1024, 0, { file, session: session('s1') }))
      .rejects.toThrow('torrent handover failed (409)')
    // A conflict means someone else is already feeding this room; silently
    // starting a second transfer from here would be the wrong repair.
    expect(file.read).not.toHaveBeenCalled()
  })
})

describe('startUrlTransfer', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('hands the url to the room and lets the server pull it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await startUrlTransfer('room1', 'https://cdn.example.com/m.mkv', 'm.mkv', 1024)
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room1/url', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      url: 'https://cdn.example.com/m.mkv', fileName: 'm.mkv', size: 1024,
    })
  })

  it('carries the reason the server gave, not just the status', async () => {
    // "not https" and "points at your own network" are different problems
    // with different fixes, and the person who has to act on it is the one
    // who installed the plugin.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"error":"unsafe_source","reason":"source url must be https"}', { status: 400 }),
    ))
    await expect(startUrlTransfer('room1', 'http://cdn.example.com/m.mkv', 'm.mkv', 1024))
      .rejects.toThrow(/must be https/)
  })

  it('still says something useful when the body is not the shape it should be', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))
    await expect(startUrlTransfer('room1', 'https://cdn.example.com/m.mkv', 'm.mkv', 1024))
      .rejects.toThrow(/502/)
  })
})
