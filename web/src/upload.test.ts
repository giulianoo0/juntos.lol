import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomAndUpload, createRoomAndUploadTorrent, subscribeUploadDone, subscribeUploadProgress, type RoomUploadProgress } from './upload'
import { convertMp4ToMkv } from './convert'
import { extractAndUploadSubtitles } from './subtitles'

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
vi.mock('./subtitles', () => ({ extractAndUploadSubtitles: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./convert', () => ({
  isMp4: vi.fn((file: File) => file.type === 'video/mp4' || /\.(mp4|m4v)$/i.test(file.name)),
  convertMp4ToMkv: vi.fn(),
}))

describe('upload registry', () => {
  let roomCounter = 0
  let roomBodies: Array<{ fileName: string; nickname: string }> = []

  beforeEach(() => {
    FakeUppy.instances = []
    roomBodies = []
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
    const uppy = FakeUppy.instances[0]
    return { result, uppy, file }
  }

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
    expect(extractAndUploadSubtitles).toHaveBeenCalledWith(converted, result.roomID)
    expect(seen).toEqual([{ phase: 'converting', pct: 50 }])
  })

  it('uploads the original mp4 unchanged when conversion fails', async () => {
    vi.mocked(convertMp4ToMkv).mockResolvedValue(null)
    const { result, uppy, file } = await startUpload(new File(['video'], 'movie.mp4', { type: 'video/mp4' }))

    expect(roomBodies[0].fileName).toBe('movie.mp4')
    expect(uppy.addFile).toHaveBeenCalledWith({ name: 'movie.mp4', type: 'video/mp4', data: file })
    expect(extractAndUploadSubtitles).toHaveBeenCalledWith(file, result.roomID)
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
      file: { name: 'episode.mkv', path: 'show/episode.mkv', size: 6, type: 'video/x-matroska', progress: 0, downloaded: 0, read },
      session: { name: 'show', files: [], stats: () => ({ peers: 1, downloadSpeed: 10, downloaded: 0, progress: 0 }), select: vi.fn(), destroy },
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
})
