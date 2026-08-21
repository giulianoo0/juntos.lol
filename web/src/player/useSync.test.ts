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

  it('pulls a recovered player back to the room position when buffering ends', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.play = vi.fn().mockResolvedValue(undefined)
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: video }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'state', state: { playing: false, positionMs: 475_000, rate: 1, serverTimeMs: 100_000 } }))

    // A playlist that is still growing has no ENDLIST, so hls.js treats it as
    // live and recovers a stall by seeking to the newest segment. The viewer
    // is thrown to the end of what has been published; the room's own position
    // is the one that counts.
    act(() => video.dispatchEvent(new Event('waiting')))
    video.currentTime = 1401
    act(() => video.dispatchEvent(new Event('canplay')))

    expect(video.currentTime).toBe(475)
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

  it('bumps roomVersion on welcome so a reconnect refetches missed room updates', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    expect(result.current.roomVersion).toBe(0)
    // A client that was disconnected while the final remux published would
    // otherwise keep playing the superseded preview forever.
    act(() => socket.receive({ type: 'welcome', memberId: 'm1', members: [] }))
    expect(result.current.roomVersion).toBe(1)
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

  it('reports readiness from the buffered range immediately when the room starts waiting', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.play = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(video, 'duration', { value: 100, configurable: true })
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 5 },
    })
    video.currentTime = 1
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    act(() => socket.receive({
      type: 'waiting',
      targetMs: 1_000,
      readiness: [{ memberId: 'm1', bufferAheadMs: 0, ready: false }],
    }))

    expect(result.current.waiting).toEqual({
      targetMs: 1_000,
      readiness: [{ memberId: 'm1', bufferAheadMs: 0, ready: false }],
    })
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'ready', positionMs: 1_000, bufferAheadMs: 4_000, stalled: false,
    }))

    // Any state broadcast ends the wait, released or withdrawn alike.
    act(() => socket.receive({ type: 'state', state: { playing: true, positionMs: 1_000, rate: 1, serverTimeMs: 100_000 } }))
    expect(result.current.waiting).toBeNull()
    unmount()
  })

  it('tracks the room gating setting from welcome and gating broadcasts', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    expect(result.current.gatingEnabled).toBe(true)
    act(() => socket.receive({ type: 'welcome', memberId: 'm1', members: [], gating: false }))
    expect(result.current.gatingEnabled).toBe(false)
    act(() => socket.receive({ type: 'gating', gating: true }))
    expect(result.current.gatingEnabled).toBe(true)
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

  it('collects relayed title requests as a rolling inbox', () => {
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    act(() => socket.receive({
      type: 'titleRequest',
      memberId: 'm2',
      title: { metaId: 'tt0903747', metaType: 'series', name: 'Breaking Bad', poster: 'p', season: 1, episode: 2, from: 'guest' },
    }))
    expect(result.current.titleRequests).toHaveLength(1)
    expect(result.current.titleRequests[0]).toMatchObject({
      memberId: 'm2', from: 'guest', metaId: 'tt0903747', metaType: 'series',
      name: 'Breaking Bad', poster: 'p', season: 1, episode: 2,
    })
    // A frame without a title payload is ignored rather than rendered empty.
    act(() => socket.receive({ type: 'titleRequest', memberId: 'm2' }))
    expect(result.current.titleRequests).toHaveLength(1)
    unmount()
  })
})
