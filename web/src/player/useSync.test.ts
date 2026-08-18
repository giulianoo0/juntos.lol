import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSync } from './useSync'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  url: string
  constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this) }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

describe('useSync', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
  })

  afterEach(() => vi.restoreAllMocks())

  it('only seeks when state drift exceeds the threshold', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.play = vi.fn().mockResolvedValue(undefined)
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: video }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    video.currentTime = 30.1
    act(() => socket.receive({ type: 'state', state: { playing: true, positionMs: 30_000, rate: 1, serverTimeMs: 100_000 } }))
    expect(video.currentTime).toBe(30.1)

    video.currentTime = 29
    act(() => socket.receive({ type: 'state', state: { playing: true, positionMs: 30_000, rate: 1, serverTimeMs: 100_000 } }))
    expect(video.currentTime).toBe(30)
    unmount()
  })

  it('sends the nickname only in the websocket hello frame, never in the URL', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'private name', videoRef))
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://localhost/ws/rooms/r1')
    act(() => socket.onopen?.())
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"nickname":"private name"'))
    unmount()
  })

  it('bumps roomVersion on every room update without treating uploads as ready', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    expect(result.current.roomVersion).toBe(0)
    act(() => socket.receive({ type: 'roomStatus', status: 'uploading' }))
    expect(result.current.roomStatus).toBe('uploading')
    expect(result.current.roomVersion).toBe(1)
    act(() => socket.receive({ type: 'roomUpdated' }))
    expect(result.current.roomStatus).toBe('uploading')
    expect(result.current.roomVersion).toBe(2)
    act(() => socket.receive({ type: 'roomStatus', status: 'ready' }))
    expect(result.current.roomVersion).toBe(3)
    // Repeated updates must remain observable even when the status is equal.
    act(() => socket.receive({ type: 'roomStatus', status: 'ready' }))
    expect(result.current.roomVersion).toBe(4)
    act(() => socket.receive({ type: 'roomStatus', status: 'processing' }))
    expect(result.current.roomVersion).toBe(5)
    unmount()
  })

  it('does not announce the people already watching when a client arrives', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    act(() => socket.receive({
      type: 'welcome',
      memberId: 'm3',
      controllerId: 'm1',
      members: [
        { id: 'm1', nickname: 'Ana', joinedAt: '2026-01-01T00:00:00Z' },
        { id: 'm3', nickname: 'giuli', joinedAt: '2026-01-01T00:02:00Z' },
      ],
    }))

    expect(result.current.members).toHaveLength(2)
    expect(result.current.presence).toEqual([])
    unmount()
  })

  it('reports who joined and who left by diffing the roster', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    const ana = { id: 'm1', nickname: 'Ana', joinedAt: '2026-01-01T00:00:00Z' }
    const me = { id: 'm3', nickname: 'giuli', joinedAt: '2026-01-01T00:02:00Z' }
    const bob = { id: 'm4', nickname: 'Bob', joinedAt: '2026-01-01T00:03:00Z' }

    act(() => socket.receive({ type: 'welcome', memberId: 'm3', controllerId: 'm1', members: [ana, me] }))
    act(() => socket.receive({ type: 'members', controllerId: 'm1', members: [ana, me, bob] }))

    expect(result.current.presence).toMatchObject([{ memberId: 'm4', nickname: 'Bob', kind: 'join' }])

    act(() => socket.receive({ type: 'members', controllerId: 'm3', members: [me, bob] }))

    expect(result.current.presence).toMatchObject([
      { memberId: 'm4', nickname: 'Bob', kind: 'join' },
      { memberId: 'm1', nickname: 'Ana', kind: 'leave' },
    ])
    // Ids are unique and increasing so the toast queue can track what it showed.
    expect(result.current.presence[1].id).toBeGreaterThan(result.current.presence[0].id)
    unmount()
  })

  it('reports no change when the roster is rebroadcast unchanged', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    const members = [{ id: 'm1', nickname: 'Ana', joinedAt: '2026-01-01T00:00:00Z' }]

    act(() => socket.receive({ type: 'welcome', memberId: 'm1', controllerId: 'm1', members }))
    act(() => socket.receive({ type: 'members', controllerId: 'm1', members }))
    act(() => socket.receive({ type: 'members', controllerId: 'm1', members }))

    expect(result.current.presence).toEqual([])
    unmount()
  })
})
