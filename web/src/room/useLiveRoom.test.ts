import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSnapshot, RoomInfo } from '../types'
import { emptyRoom, useLiveRoom, type LiveRoomSync } from './useLiveRoom'

const room = (patch: Partial<RoomInfo> = {}): RoomInfo => ({ ...emptyRoom('r1'), status: 'ready', fileName: 'a.mkv', mediaGeneration: 2, mediaVersion: 1, ...patch })

const sync = (patch: Partial<LiveRoomSync> = {}): LiveRoomSync => ({
  roomVersion: 0, mediaPatch: null, refreshRoom: vi.fn(), memberId: 'm1', capability: 'cap', ...patch,
})

let served: RoomInfo
const fetchMock = vi.fn(async () => new Response(JSON.stringify(served), { status: 200 }))

beforeEach(() => {
  served = room({ fileName: 'novo.mkv' })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

describe('useLiveRoom', () => {
  it('busca a sala de novo a cada versão, como membro', async () => {
    const { result, rerender } = renderHook((props: LiveRoomSync) => useLiveRoom(room(), props), { initialProps: sync() })
    expect(fetchMock).not.toHaveBeenCalled()
    rerender(sync({ roomVersion: 1 }))
    await waitFor(() => expect(result.current[0].fileName).toBe('novo.mkv'))
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/r1', expect.objectContaining({ headers: { 'X-Member-Id': 'm1', 'X-Capability': 'cap' } }))
  })

  it('aplica o que um publish moveu sem buscar a sala', () => {
    const patch: MediaSnapshot = { mediaGeneration: 2, mediaVersion: 3, mediaOffsetMs: 500, mediaRegions: null }
    const { result, rerender } = renderHook((props: LiveRoomSync) => useLiveRoom(room(), props), { initialProps: sync() })
    rerender(sync({ mediaPatch: patch }))
    expect(result.current[0]).toMatchObject({ mediaVersion: 3, mediaOffsetMs: 500 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('um publish de outra mídia pede a sala inteira', () => {
    const refreshRoom = vi.fn()
    const patch: MediaSnapshot = { mediaGeneration: 3, mediaVersion: 1, mediaOffsetMs: 0, mediaRegions: null }
    const { result, rerender } = renderHook((props: LiveRoomSync) => useLiveRoom(room(), props), { initialProps: sync({ refreshRoom }) })
    rerender(sync({ refreshRoom, mediaPatch: patch }))
    expect(refreshRoom).toHaveBeenCalled()
    expect(result.current[0].mediaGeneration).toBe(2)
  })
})
