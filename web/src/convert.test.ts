import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOB_FALLBACK_MAX_BYTES, convertMp4ToMkv, isMp4, NoVideoTrackError } from './convert'

const mediabunny = vi.hoisted(() => {
  const state = {
    videoTrack: { type: 'video' } as { type: string } | null,
    isValid: true,
    discardedTracks: [] as Array<{ track: { type: string } }>,
    executeError: null as Error | null,
    initCalls: 0,
  }

  class BlobSource {
    blob: Blob
    constructor(blob: Blob) { this.blob = blob }
  }
  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }
  class StreamTarget {
    writable: unknown
    options?: unknown
    constructor(writable: unknown, options?: unknown) { this.writable = writable; this.options = options }
  }
  class MkvOutputFormat {}
  class Output {
    options: { format: MkvOutputFormat; target: BufferTarget | StreamTarget }
    constructor(options: { format: MkvOutputFormat; target: BufferTarget | StreamTarget }) { this.options = options }
  }
  class Input {
    options: unknown
    constructor(options: unknown) { this.options = options }
    async getPrimaryVideoTrack() { return state.videoTrack }
    dispose() {}
  }
  class Conversion {
    options: { output: Output }
    onProgress?: (progress: number) => void
    isValid = state.isValid
    discardedTracks = state.discardedTracks
    constructor(options: { output: Output }) { this.options = options }
    static async init(options: { output: Output }) {
      state.initCalls += 1
      return new Conversion(options)
    }
    async execute() {
      if (state.executeError) throw state.executeError
      this.onProgress?.(0.5)
      const { target } = this.options.output.options
      if (target instanceof BufferTarget) target.buffer = new ArrayBuffer(8)
    }
  }

  return { state, BlobSource, BufferTarget, StreamTarget, MkvOutputFormat, Output, Input, Conversion, MP4: {}, QTFF: {} }
})

vi.mock('mediabunny', () => mediabunny)

function stubOpfs() {
  const removeEntry = vi.fn(async () => undefined)
  const snapshot = new File(['mkv-bytes'], 'ss-convert-test.mkv')
  const getFile = vi.fn(async () => snapshot)
  const createWritable = vi.fn(async () => ({}))
  const getFileHandle = vi.fn(async () => ({ createWritable, getFile }))
  const getDirectory = vi.fn(async () => ({ getFileHandle, removeEntry }))
  Object.defineProperty(navigator, 'storage', { value: { getDirectory }, configurable: true })
  return { removeEntry, getFile, createWritable, snapshot }
}

describe('isMp4', () => {
  it('detects by mime type and by extension', () => {
    expect(isMp4(new File(['x'], 'movie.mp4'))).toBe(true)
    expect(isMp4(new File(['x'], 'movie.m4v'))).toBe(true)
    expect(isMp4(new File(['x'], 'movie', { type: 'video/mp4' }))).toBe(true)
    expect(isMp4(new File(['x'], 'movie.mkv', { type: 'video/x-matroska' }))).toBe(false)
  })
})

describe('convertMp4ToMkv', () => {
  beforeEach(() => {
    mediabunny.state.videoTrack = { type: 'video' }
    mediabunny.state.isValid = true
    mediabunny.state.discardedTracks = []
    mediabunny.state.executeError = null
    mediabunny.state.initCalls = 0
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
  })

  it('writes to an in-memory buffer when OPFS is unavailable and the file is small', async () => {
    const converted = await convertMp4ToMkv(new File(['video'], 'movie.mp4', { type: 'video/mp4' }))
    expect(converted).not.toBeNull()
    expect(converted?.name).toBe('movie.mkv')
    expect(converted?.type).toBe('video/x-matroska')
  })

  it('streams into OPFS when available and cleans up the temp file', async () => {
    const opfs = stubOpfs()
    const converted = await convertMp4ToMkv(new File(['video'], 'movie.m4v'))
    expect(opfs.createWritable).toHaveBeenCalledOnce()
    expect(converted?.name).toBe('movie.mkv')
    expect(converted?.type).toBe('video/x-matroska')
    expect(await converted?.text()).toBe(await opfs.snapshot.text())
    expect(opfs.removeEntry).toHaveBeenCalledOnce()
  })

  it('reports progress while converting', async () => {
    const onProgress = vi.fn()
    await convertMp4ToMkv(new File(['video'], 'movie.mp4'), onProgress)
    expect(onProgress).toHaveBeenCalledWith(50)
  })

  it('returns null for large files when OPFS is unavailable', async () => {
    const file = new File(['x'], 'big.mp4')
    Object.defineProperty(file, 'size', { value: BLOB_FALLBACK_MAX_BYTES + 1 })
    expect(await convertMp4ToMkv(file)).toBeNull()
    expect(mediabunny.state.initCalls).toBe(0)
  })

  it('rejects with NoVideoTrackError when the file has no video track', async () => {
    mediabunny.state.videoTrack = null
    await expect(convertMp4ToMkv(new File(['x'], 'audio.mp4'))).rejects.toBeInstanceOf(NoVideoTrackError)
  })

  it('returns null when conversion throws mid-way', async () => {
    mediabunny.state.executeError = new Error('muxer exploded')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(convertMp4ToMkv(new File(['x'], 'movie.mp4'))).resolves.toBeNull()
  })

  it('returns null when the video track cannot be represented in MKV', async () => {
    mediabunny.state.discardedTracks = [{ track: { type: 'video' } }]
    await expect(convertMp4ToMkv(new File(['x'], 'movie.mp4'))).resolves.toBeNull()
  })

  it('returns null when the conversion is invalid', async () => {
    mediabunny.state.isValid = false
    await expect(convertMp4ToMkv(new File(['x'], 'movie.mp4'))).resolves.toBeNull()
  })
})
