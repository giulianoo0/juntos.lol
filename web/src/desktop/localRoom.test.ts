import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDesktopForTests } from '../platform'
import { registerRemuxHandle, remuxHandleFor } from '../upload'
import {
  attachLocalRoom, browserMediaIdle, closeLocalCopy, followLocalCopy, localMediaFor, needBrowserMedia, openLocalCopy,
  refreshLocalMedia, resetLocalRoomsForTests, safeLocalCopy, setLocalRenditions,
} from './localRoom'

const regions = [{ n: 0, startMs: 0, producedMs: 8000, growing: true }]
const meta = { key: 't-abc-0', title: 'Filme', durationMs: 600000, audioLangs: ['eng'], videoCodecs: null, regions: [] }

let invoke: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }
    if (cmd === 'local_prepare') return meta
    if (cmd === 'local_regions') return regions
    if (cmd === 'torrent_open') return { id: 'abc', name: 'Filme', files: [] }
    return null
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  resetDesktopForTests()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ claim: 'CLAIM', mediaGeneration: 4, maxBytes: 1, metadataToken: 'm' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  resetLocalRoomsForTests()
  vi.unstubAllGlobals()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetDesktopForTests()
})

const source = { kind: 'torrent' as const, id: 'abc', index: 0, title: 'Filme' }

/** The room's media is at `generation` now: a promote answers for it. */
function serverAt(generation: number): void {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ claim: 'CLAIM', mediaGeneration: generation }), { status: 200 }))
}

describe('a room played from the desktop cache', () => {
  it('prepares the source and plays its regions from the cache', async () => {
    expect(await attachLocalRoom('ROOM1', 4, source)).toBeNull()
    expect(invoke).toHaveBeenCalledWith('local_prepare', { source })
    await refreshLocalMedia('ROOM1')
    expect(localMediaFor('ROOM1')).toEqual({ root: 'juntos-media://localhost/t-abc-0', generation: 4, regions })
  })

  it('has the app publish the source\'s subtitles to the room as the seat that opened it, and a guest copy never does', async () => {
    await attachLocalRoom('ROOM0', 4, source)
    expect(invoke).not.toHaveBeenCalledWith('local_subtitles', expect.anything())
    await attachLocalRoom('ROOM1', 4, source, { memberId: 'm1', capability: 'cap' })
    expect(invoke).toHaveBeenCalledWith('local_subtitles', { key: 't-abc-0', roomId: 'ROOM1', mediaGeneration: 4, memberId: 'm1', capability: 'cap' })
    invoke.mockClear()
    await openLocalCopy('GUEST2', 4, { kind: 'torrent', magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10', index: 0 }, 'Filme')
    expect(invoke).not.toHaveBeenCalledWith('local_subtitles', expect.anything())
  })

  it('an app too old to publish subtitles still plays the room', async () => {
    const plain = invoke.getMockImplementation() as (cmd: string, args?: unknown) => Promise<unknown>
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'local_subtitles') throw new Error('command local_subtitles not found')
      return plain(cmd, args)
    })
    expect(await attachLocalRoom('ROOM1', 4, source, { memberId: 'm1', capability: 'cap' })).toBeNull()
    expect(remuxHandleFor('ROOM1')).toBeDefined()
  })

  it('hands the room position to the app', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    remuxHandleFor('ROOM1')?.follow(42_000)
    expect(invoke).toHaveBeenCalledWith('local_follow', { key: 't-abc-0', positionMs: 42_000 })
  })

  it('hands a burst of positions to the app once now and the last one 3 s later', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    vi.useFakeTimers()
    try {
      const handle = remuxHandleFor('ROOM1')
      handle?.follow(10_000)
      handle?.follow(20_000)
      handle?.follow(30_000)
      const follows = () => invoke.mock.calls.filter(([cmd]) => cmd === 'local_follow').map(([, args]) => args.positionMs)
      expect(follows()).toEqual([10_000])
      await vi.advanceTimersByTimeAsync(2_999)
      expect(follows()).toEqual([10_000])
      await vi.advanceTimersByTimeAsync(1)
      expect(follows()).toEqual([10_000, 30_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a play at the same place does not hold the next seek back', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    vi.useFakeTimers()
    try {
      const handle = remuxHandleFor('ROOM1')
      handle?.follow(10_000)
      await vi.advanceTimersByTimeAsync(3_000)
      handle?.follow(10_400)
      handle?.follow(420_000)
      const follows = () => invoke.mock.calls.filter(([cmd]) => cmd === 'local_follow').map(([, args]) => args.positionMs)
      expect(follows()).toEqual([10_000, 420_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a browser guest promotes the room and starts the upload at the playhead', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    remuxHandleFor('ROOM1')?.follow(42_000)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/ROOM1/local/promote', expect.objectContaining({ method: 'POST', body: JSON.stringify({ memberId: 'm1', capability: 'cap' }) }))
    expect(invoke).toHaveBeenCalledWith('upload_start', { key: 't-abc-0', roomId: 'ROOM1', claim: 'CLAIM', mediaGeneration: 4, positionMs: 42_000 })
  })

  it('a browser guest asking while the next source is prepared gets that one, never the old one', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    let prepared!: (value: unknown) => void
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }
      if (cmd === 'local_prepare') return new Promise((resolve) => { prepared = resolve })
      return null
    })
    const swapping = attachLocalRoom('ROOM1', 5, { ...source, id: 'def' })
    await vi.waitFor(() => expect(prepared).toBeDefined())
    serverAt(5)

    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 5)
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.anything())

    prepared({ ...meta, key: 't-def-0' })
    await swapping
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('upload_start', expect.objectContaining({ key: 't-def-0' })))
  })

  it('a browser guest asking for the next source before the swap reaches this tab gets that one, never the old cache', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    serverAt(5)

    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 5)
    // The swap hands the room to the next source's producer, releasing this one.
    registerRemuxHandle('ROOM1', { follow: () => undefined }, () => undefined)
    invoke.mockImplementation(async (cmd: string) => cmd === 'local_prepare' ? { ...meta, key: 't-def-0' } : null)
    await attachLocalRoom('ROOM1', 5, { ...source, id: 'def' })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('upload_start', expect.objectContaining({ key: 't-def-0', mediaGeneration: 5 })))
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.objectContaining({ key: 't-abc-0' }))
  })

  it('a promote the server answers for a newer source uploads nothing from this cache', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ claim: 'CLAIM', mediaGeneration: 5 }), { status: 200 }))
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.anything())
  })

  it('a browser guest already waiting gets the new source after a swap', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
    invoke.mockClear()
    invoke.mockImplementation(async (cmd: string) => cmd === 'local_prepare' ? { ...meta, key: 't-def-0' } : null)
    serverAt(5)

    await attachLocalRoom('ROOM1', 5, { ...source, id: 'def' })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('upload_start', expect.objectContaining({ key: 't-def-0' })))
  })

  it('once the last browser guest left, a swap uploads nothing', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
    await browserMediaIdle('ROOM1')
    invoke.mockClear()
    invoke.mockImplementation(async (cmd: string) => cmd === 'local_prepare' ? { ...meta, key: 't-def-0' } : null)

    await attachLocalRoom('ROOM1', 5, { ...source, id: 'def' })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.anything())
  })

  it('a refused promote starts nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_local' }), { status: 409 }))
    await attachLocalRoom('ROOM1', 4, source)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.anything())
  })

  it('a room this app does not produce ignores the event', async () => {
    await needBrowserMedia('OTHER', { memberId: 'm1', capability: 'cap' }, 4)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks the app for 480p once the room wants it, from the playhead, and only on a change', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    remuxHandleFor('ROOM1')?.follow(42_000)
    await setLocalRenditions('ROOM1', undefined)
    expect(invoke).not.toHaveBeenCalledWith('local_low', expect.anything())
    await setLocalRenditions('ROOM1', ['480p'])
    await setLocalRenditions('ROOM1', ['480p'])
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'local_low')).toEqual([
      ['local_low', { key: 't-abc-0', on: true, positionMs: 42_000 }],
    ])
    await setLocalRenditions('ROOM1', [])
    expect(invoke).toHaveBeenLastCalledWith('local_low', { key: 't-abc-0', on: false, positionMs: 42_000 })
  })

  it('promotes again when the upload dies with a guest waiting, not when it finished or nobody waits', async () => {
    let status = { active: true, sent: 0, error: null as string | null }
    const base = invoke.getMockImplementation() as (cmd: string, args?: unknown) => Promise<unknown>
    invoke.mockImplementation(async (cmd: string, args?: unknown) => (cmd === 'upload_status' ? status : base(cmd, args)))
    await attachLocalRoom('ROOM1', 4, source)
    vi.useFakeTimers()
    try {
      await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' }, 4)
      const starts = () => invoke.mock.calls.filter(([cmd]) => cmd === 'upload_start').length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(starts()).toBe(1)
      status = { active: false, sent: 9, error: null }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(starts()).toBe(1)
      status = { active: false, sent: 9, error: 'presign refused: 403 Forbidden' }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(starts()).toBe(2)
      await browserMediaIdle('ROOM1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(starts()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the upload when the last browser guest leaves', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    await browserMediaIdle('ROOM1')
    expect(invoke).toHaveBeenCalledWith('upload_stop', { roomId: 'ROOM1' })
  })

  it('a refused prepare is the reason, and nothing is attached', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }
      throw 'torrent not live'
    })
    expect(await attachLocalRoom('ROOM1', 4, source)).toContain('torrent not live')
    expect(localMediaFor('ROOM1')).toBeNull()
  })
})

describe('a guest on the app playing its own copy', () => {
  const magnet = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=A%20Viagem%20de%20Chihiro%20%E2%80%93%20Dublado'
  const torrentCopy = { kind: 'torrent' as const, magnet, index: 2 }
  const calls = (name: string) => invoke.mock.calls.filter(([cmd]) => cmd === name).map(([, args]) => args)

  it('opens the same torrent, picks the same file and plays its own cache', async () => {
    expect(await openLocalCopy('ROOM1', 4, torrentCopy, 'A Viagem de Chihiro – 千と千尋')).toBeNull()
    expect(calls('torrent_open')).toEqual([{ magnet }])
    expect(calls('torrent_select')).toEqual([{ id: 'abc', index: 2 }])
    expect(calls('local_prepare')).toEqual([{ source: { kind: 'torrent', id: 'abc', index: 2, title: 'A Viagem de Chihiro – 千と千尋' } }])
    await refreshLocalMedia('ROOM1')
    expect(localMediaFor('ROOM1')).toEqual({ root: 'juntos-media://localhost/t-abc-0', generation: 4, regions })
  })

  it('opens the same video', async () => {
    const copy = { kind: 'youtube' as const, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' }
    expect(await openLocalCopy('ROOM1', 4, copy, 'Clipe')).toBeNull()
    expect(calls('local_prepare')).toEqual([{ source: { ...copy, title: 'Clipe' } }])
    expect(calls('torrent_open')).toEqual([])
  })

  it('is no producer: the room never asks it to upload', async () => {
    await openLocalCopy('GUEST1', 4, torrentCopy, 'Filme')
    expect(remuxHandleFor('GUEST1')).toBeUndefined()
    await needBrowserMedia('GUEST1', { memberId: 'm2', capability: 'cap' }, 4)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(calls('upload_start')).toEqual([])
  })

  it('follows the room in its own cache', async () => {
    await openLocalCopy('ROOM1', 4, torrentCopy, 'Filme')
    followLocalCopy('ROOM1', 42_000)
    expect(calls('local_follow')).toEqual([{ key: 't-abc-0', positionMs: 42_000 }])
  })

  it('a swarm that will not open, or a prepare that fails, is the reason and attaches nothing', async () => {
    invoke.mockImplementationOnce(async () => ({ protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }))
    invoke.mockImplementationOnce(async () => { throw new Error('no peers') })
    expect(await openLocalCopy('ROOM1', 4, torrentCopy, 'Filme')).toBe('torrent open failed: no peers')
    expect(localMediaFor('ROOM1')).toBeNull()

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'local_prepare') throw new Error('ffprobe failed')
      return { id: 'abc' }
    })
    expect(await openLocalCopy('ROOM1', 4, torrentCopy, 'Filme')).toMatch(/^local prepare failed: ffprobe failed/)
    expect(localMediaFor('ROOM1')).toBeNull()
  })

  it('closing stops its production and keeps the cache; an old generation closes nothing', async () => {
    await openLocalCopy('ROOM1', 4, torrentCopy, 'Filme')
    closeLocalCopy('ROOM1', 3)
    expect(localMediaFor('ROOM1')).not.toBeNull()
    closeLocalCopy('ROOM1', 4)
    expect(localMediaFor('ROOM1')).toBeNull()
    await vi.waitFor(() => expect(calls('local_stop')).toEqual([{ key: 't-abc-0' }]))
  })

  it('closing never touches a room this app produces', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    closeLocalCopy('ROOM1', 4)
    expect(localMediaFor('ROOM1')).not.toBeNull()
    expect(remuxHandleFor('ROOM1')).toBeDefined()
  })

  it('opening a source of its own stops the copy it was playing', async () => {
    await openLocalCopy('ROOM1', 4, torrentCopy, 'Filme')
    invoke.mockImplementation(async (cmd: string) => (cmd === 'local_prepare' ? { ...meta, key: 'y-xyz-0' } : null))
    expect(await attachLocalRoom('ROOM1', 5, { kind: 'youtube', url: 'https://youtu.be/xyz', videoId: 'xyz', title: 'Outro' })).toBeNull()
    expect(calls('local_stop')).toEqual([{ key: 't-abc-0' }])
    expect(remuxHandleFor('ROOM1')).toBeDefined()
    followLocalCopy('ROOM1', 9_000)
    expect(calls('local_follow')).toEqual([])
  })

  it('opens only what is safe of what the host shared', () => {
    const hostile = 'magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=Ma%C3%A7%C3%A3'
      + '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
      + '&tr=http%3A%2F%2F192.168.0.1%2Fannounce&tr=http%3A%2F%2Flocalhost%3A8080%2Fa&tr=http%3A%2F%2F%5B%3A%3A1%5D%2Fa'
      + '&tr=http%3A%2F%2Frouter.lan%2Fa&tr=http%3A%2F%2F0x7f000001%2Fa&tr=file%3A%2F%2F%2Fetc%2Fpasswd'
      + '&ws=http%3A%2F%2F10.0.0.2%2Fmovie.mkv&xs=http%3A%2F%2F10.0.0.2%2Fa.torrent&x.pe=192.168.0.5%3A6881'
    expect(safeLocalCopy({ kind: 'torrent', magnet: hostile, index: 1 })).toEqual({
      kind: 'torrent',
      magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Ma%C3%A7%C3%A3&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
      index: 1,
    })
    expect(safeLocalCopy({ kind: 'torrent', magnet: 'magnet:?xt=urn:btih:nothash', index: 0 })).toBeNull()
    expect(safeLocalCopy({ kind: 'torrent', magnet: hostile, index: -1 })).toBeNull()

    expect(safeLocalCopy({ kind: 'youtube', url: 'https://evil.example/x?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' })).toEqual({
      kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ',
    })
    expect(safeLocalCopy({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=x', videoId: '../../etc' })).toBeNull()
  })

  it('refuses to open what is not safe, and opens nothing for it', async () => {
    expect(await openLocalCopy('GUEST3', 4, { kind: 'youtube', url: 'https://youtu.be/x', videoId: 'x' }, 'Clipe')).toMatch(/not one the app opens/)
    expect(calls('local_prepare')).toEqual([])
  })
})
