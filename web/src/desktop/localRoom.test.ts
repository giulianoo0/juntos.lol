import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDesktopForTests } from '../platform'
import { remuxHandleFor } from '../upload'
import { attachLocalRoom, browserMediaIdle, localMediaFor, needBrowserMedia, refreshLocalMedia, resetLocalRoomsForTests, setLocalRenditions } from './localRoom'

const regions = [{ n: 0, startMs: 0, producedMs: 8000, growing: true }]
const meta = { key: 't-abc-0', title: 'Filme', durationMs: 600000, audioLangs: ['eng'], videoCodecs: null, regions: [] }

let invoke: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }
    if (cmd === 'local_prepare') return meta
    if (cmd === 'local_regions') return regions
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

describe('a room played from the desktop cache', () => {
  it('prepares the source and plays its regions from the cache', async () => {
    expect(await attachLocalRoom('ROOM1', 4, source)).toBeNull()
    expect(invoke).toHaveBeenCalledWith('local_prepare', { source })
    await refreshLocalMedia('ROOM1')
    expect(localMediaFor('ROOM1')).toEqual({ root: 'juntos-media://localhost/t-abc-0', generation: 4, regions })
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

  it('a browser guest promotes the room and starts the upload at the playhead', async () => {
    await attachLocalRoom('ROOM1', 4, source)
    remuxHandleFor('ROOM1')?.follow(42_000)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' })
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/ROOM1/local/promote', expect.objectContaining({ method: 'POST', body: JSON.stringify({ memberId: 'm1', capability: 'cap' }) }))
    expect(invoke).toHaveBeenCalledWith('upload_start', { key: 't-abc-0', roomId: 'ROOM1', claim: 'CLAIM', mediaGeneration: 4, positionMs: 42_000 })
  })

  it('a refused promote starts nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_local' }), { status: 409 }))
    await attachLocalRoom('ROOM1', 4, source)
    await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' })
    expect(invoke).not.toHaveBeenCalledWith('upload_start', expect.anything())
  })

  it('a room this app does not produce ignores the event', async () => {
    await needBrowserMedia('OTHER', { memberId: 'm1', capability: 'cap' })
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
      await needBrowserMedia('ROOM1', { memberId: 'm1', capability: 'cap' })
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
