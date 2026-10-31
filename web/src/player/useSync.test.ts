import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { savePickedAvatar } from '../room/avatar'
import { useSync } from './useSync'

const localRoomFakes = vi.hoisted(() => ({ needBrowserMedia: vi.fn(), browserMediaIdle: vi.fn() }))
vi.mock('../desktop/localRoom', () => localRoomFakes)

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('only seeks when state drift exceeds the threshold', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.play = vi.fn().mockResolvedValue(undefined)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
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
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'state', state: { playing: false, positionMs: 475_000, rate: 1, serverTimeMs: 100_000 } }))

    act(() => result.current.reportBuffering(true))
    video.currentTime = 1401
    act(() => result.current.reportBuffering(false))

    expect(video.currentTime).toBe(475)
    unmount()
  })

  it('sends the nickname only in the websocket hello frame, never in the URL', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'private name', videoRef))
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://localhost/ws/rooms/r1')
    act(() => socket.onopen?.())
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"nickname":"private name"'))
    unmount()
  })

  it('says in the hello which avatar this browser picked', () => {
    savePickedAvatar('cat-preto.beanie')
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toMatchObject({ type: 'hello', avatar: 'cat-preto.beanie' })
    unmount()
    localStorage.clear()
  })

  it('says in the hello that the desktop app plays a local source and opens its own copy, and a browser says nothing', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const browser = renderHook(() => useSync('r1', 'giuli', videoRef))
    act(() => FakeWebSocket.instances[0].onopen?.())
    const plain = JSON.parse(FakeWebSocket.instances[0].send.mock.calls[0][0] as string)
    expect(plain.client).toBeUndefined()
    expect(plain.features).toBeUndefined()
    browser.unmount()

    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    const app = renderHook(() => useSync('r1', 'giuli', videoRef))
    act(() => FakeWebSocket.instances[1].onopen?.())
    expect(JSON.parse(FakeWebSocket.instances[1].send.mock.calls[0][0] as string)).toMatchObject({ client: 'desktop', features: ['localSource', 'localCopy'] })
    app.unmount()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('hands needBrowserMedia and browserMediaIdle to the local room with the seat', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'welcome', memberId: 'm1', capability: 'cap', controllerId: 'm1', members: [] }))
    act(() => socket.receive({ type: 'needBrowserMedia', generation: 4 }))
    expect(localRoomFakes.needBrowserMedia).toHaveBeenCalledWith('r1', { memberId: 'm1', capability: 'cap' }, 4)
    act(() => socket.receive({ type: 'browserMediaIdle' }))
    expect(localRoomFakes.browserMediaIdle).toHaveBeenCalledWith('r1')
    unmount()
  })

  it('names the same browser in the hello of every tab', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const first = renderHook(() => useSync('r1', 'giuli', videoRef))
    const second = renderHook(() => useSync('r1', 'giuli', videoRef))
    const [a, b] = FakeWebSocket.instances
    act(() => { a.onopen?.(); b.onopen?.() })
    const device = JSON.parse(a.send.mock.calls[0][0] as string).device
    expect(device).toBeTruthy()
    expect(JSON.parse(b.send.mock.calls[0][0] as string).device).toBe(device)
    first.unmount()
    second.unmount()
    localStorage.clear()
  })

  it('says it is leaving when the tab goes away and when the room page closes', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    const leaves = () => socket.send.mock.calls.filter(([frame]) => JSON.parse(frame as string).type === 'leave').length
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(leaves()).toBe(1)
    unmount()
    expect(leaves()).toBe(2)
  })

  it('stops for good when another tab of this browser takes the seat', () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.receive({ type: 'error', error: 'replaced' }))
    expect(result.current.replaced).toBe(true)
    expect(result.current.left).toBe(true)
    act(() => { socket.onclose?.() })
    act(() => { vi.advanceTimersByTime(30_000) })
    unmount()
    // Neither coming back to the tab nor to the network takes the seat back, not even after the page is gone.
    act(() => { window.dispatchEvent(new Event('online')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.useRealTimers()
  })

  it('bumps roomVersion on every room update without treating uploads as ready', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    act(() => socket.receive({ type: 'roomStatus', status: 'ready' }))
    expect(result.current.roomVersion).toBe(4)
    act(() => socket.receive({ type: 'roomStatus', status: 'processing' }))
    expect(result.current.roomVersion).toBe(5)
    unmount()
  })

  it('hands a publish that says what moved to the page instead of bumping roomVersion', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    const media = { mediaGeneration: 0, mediaVersion: 3, mediaOffsetMs: 1000, mediaRegions: [{ n: 0, startMs: 0, producedMs: 4000, growing: true }] }
    act(() => socket.receive({ type: 'roomUpdated', media }))
    expect(result.current.roomVersion).toBe(0)
    expect(result.current.mediaPatch).toEqual(media)
    act(() => result.current.refreshRoom())
    expect(result.current.roomVersion).toBe(1)
    unmount()
  })

  it('leaves for good: the socket closes and no reconnect follows', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.receive({ type: 'stillThere', deadlineMs: Date.now() + 1000 }))
    expect(result.current.stillThereDeadlineMs).not.toBeNull()
    act(() => result.current.leave())
    expect(result.current.left).toBe(true)
    expect(result.current.stillThereDeadlineMs).toBeNull()
    expect(socket.close).toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(1)
    unmount()
  })

  it('bumps roomVersion on welcome so a reconnect refetches missed room updates', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]

    expect(result.current.roomVersion).toBe(0)
    act(() => socket.receive({ type: 'welcome', memberId: 'm1', members: [] }))
    expect(result.current.roomVersion).toBe(1)
    unmount()
  })

  it('does not announce the people already watching when a client arrives', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
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
      type: 'ready', positionMs: 1_000, bufferAheadMs: 4_000, stalled: false, bandwidthKbps: 0, mediaKbps: 0,
    }))

    act(() => socket.receive({ type: 'state', state: { playing: true, positionMs: 1_000, rate: 1, serverTimeMs: 100_000 } }))
    expect(result.current.waiting).toBeNull()
    unmount()
  })

  it('tracks the room gating setting from welcome and gating broadcasts', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
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
    act(() => socket.receive({ type: 'titleRequest', memberId: 'm2' }))
    expect(result.current.titleRequests).toHaveLength(1)
    unmount()
  })
  it('reconnects after the socket drops, and stops once the room is left', () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    expect(FakeWebSocket.instances).toHaveLength(1)

    const first = FakeWebSocket.instances[0]
    first.readyState = 3
    act(() => { first.onclose?.() })
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    unmount()
    act(() => { FakeWebSocket.instances[1].onclose?.() })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.useRealTimers()
  })

  it('stays connected in a background tab whose timers fire once a minute', () => {
    vi.useFakeTimers()
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    // The server answers each heartbeat the moment it arrives.
    socket.send.mockImplementation((frame: string) => {
      if (JSON.parse(frame).type === 'heartbeat') socket.receive({ type: 'pong' })
    })

    for (let minute = 0; minute < 3; minute += 1) {
      now += 60_000
      act(() => { vi.advanceTimersByTime(5_000) })
    }

    expect(socket.close).not.toHaveBeenCalled()
    unmount()
    vi.useRealTimers()
  })

  it('closes a socket whose heartbeat goes unanswered, to reconnect', () => {
    vi.useFakeTimers()
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    for (let tick = 0; tick < 5; tick += 1) {
      now += 5_000
      act(() => { vi.advanceTimersByTime(5_000) })
    }

    expect(socket.close).toHaveBeenCalled()
    unmount()
    vi.useRealTimers()
  })

  it('stops for good when the server says the room is gone', () => {
    vi.useFakeTimers()
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'error', error: 'room_gone' }))
    act(() => { socket.onclose?.() })
    act(() => { vi.advanceTimersByTime(30_000) })
    // Coming back to the tab or to the network opens nothing either.
    act(() => { window.dispatchEvent(new Event('online')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })

    expect(result.current.gone).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    unmount()
    vi.useRealTimers()
  })

  it('asks whether the room still exists when the socket is turned away, and stops if it does not', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'room_not_found' }), { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    await act(async () => { FakeWebSocket.instances[0].onclose?.() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(fetch).toHaveBeenCalledWith('/api/rooms/r1/preview', expect.anything())
    expect(result.current.gone).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    unmount()
    vi.useRealTimers()
  })

  it('reports whether a command actually left the tab', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    expect(result.current.send('pause', { positionMs: 1 })).toBe(true)

    socket.readyState = 3
    expect(result.current.send('pause', { positionMs: 1 })).toBe(false)
    unmount()
  })

  it('surfaces a refusal from the server instead of swallowing it', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.receive({ type: 'error', error: 'not_controller' }))

    expect(result.current.lastError).toBe('not_controller')
    expect(result.current.errorSeq).toBe(1)
    unmount()
  })

  it('drops a stall report once the buffer has grown past the gate', () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    Object.defineProperty(video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 130 } })
    video.currentTime = 10
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    act(() => result.current.reportBuffering(true))
    expect(result.current.buffering).toBe(true)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'ready', positionMs: 10_000, bufferAheadMs: 120_000, stalled: false, bandwidthKbps: 0, mediaKbps: 0,
    }))
    expect(result.current.buffering).toBe(false)
    unmount()
    vi.useRealTimers()
  })

  it('leaves a stopped element alone when buffering ends', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.play = vi.fn().mockResolvedValue(undefined)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'state', state: { playing: false, positionMs: 475_000, rate: 1, serverTimeMs: 100_000 } }))

    act(() => result.current.reportBuffering(true))
    video.currentTime = 1401
    act(() => result.current.reportBuffering(false))
    expect(video.currentTime).toBe(1401)
    unmount()
  })

  it('falls back to muted playback when the browser refuses to autoplay on arrival', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    const refused = new DOMException('gesture required', 'NotAllowedError')
    video.play = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(undefined)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    await act(async () => {
      socket.receive({ type: 'state', state: { playing: true, positionMs: 0, rate: 1, serverTimeMs: 100_000 } })
    })

    expect(video.muted).toBe(true)
    expect(video.play).toHaveBeenCalledTimes(2)
    expect(result.current.autoplayBlocked).toBe(false)
    unmount()
  })

  it('asks for a gesture when even muted playback is refused', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    const refused = new DOMException('gesture required', 'NotAllowedError')
    video.play = vi.fn().mockRejectedValue(refused)
    const videoRef: RefObject<HTMLVideoElement | null> = { current: video }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    await act(async () => {
      socket.receive({ type: 'state', state: { playing: true, positionMs: 0, rate: 1, serverTimeMs: 100_000 } })
    })

    expect(result.current.autoplayBlocked).toBe(true)
    unmount()
  })

})

describe('useSync host subtitles', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps the host subtitle pick from welcome and from later broadcasts', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    expect(result.current.hostSubtitles).toBeNull()

    act(() => socket.receive({ type: 'welcome', memberId: 'm2', controllerId: 'm1', members: [], hostSubtitles: { track: 3, delayMs: 500 } }))
    expect(result.current.hostSubtitles).toEqual({ track: 3, delayMs: 500 })

    act(() => socket.receive({ type: 'hostSubtitles', hostSubtitles: { track: -1, delayMs: -250 } }))
    expect(result.current.hostSubtitles).toEqual({ track: -1, delayMs: -250 })
    unmount()
  })
})

describe('useSync stages', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
  })
  afterEach(() => vi.restoreAllMocks())

  const sent = (socket: FakeWebSocket) => socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>)

  it('asks the host for a stage and keeps the answer', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    act(() => { result.current.requestStage('screen') })
    expect(sent(socket)).toContainEqual({ type: 'stageRequest', kind: 'screen' })
    expect(result.current.stages.asked).toEqual(['screen'])

    act(() => socket.receive({ type: 'stageGrant', kind: 'screen', allow: true }))
    expect(result.current.stages.asked).toEqual([])
    expect(result.current.stages.granted.screen).toBe(100_000)
    expect(result.current.stages.answer).toMatchObject({ kind: 'screen', allow: true })

    act(() => socket.receive({ type: 'stageClosed', kind: 'screen' }))
    expect(result.current.stages.granted.screen).toBeUndefined()
    expect(result.current.stages.closed).toMatchObject({ kind: 'screen' })
    unmount()
  })

  it('gives the host an inbox it answers from, emptied of whoever left', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())
    act(() => socket.receive({ type: 'stageRequest', requestId: 'q1', memberId: 'm2', nickname: 'ana', kind: 'media' }))
    act(() => socket.receive({ type: 'stageRequest', requestId: 'q2', memberId: 'm3', nickname: 'bia', kind: 'screen' }))
    expect(result.current.stages.requests.map((request) => request.requestId)).toEqual(['q1', 'q2'])

    act(() => { result.current.answerStage('q1', true) })
    expect(sent(socket)).toContainEqual({ type: 'stageAnswer', requestId: 'q1', allow: true })
    expect(result.current.stages.requests.map((request) => request.requestId)).toEqual(['q2'])

    act(() => socket.receive({ type: 'members', controllerId: 'm1', members: [{ id: 'm1', nickname: 'giuli', joinedAt: '' }] }))
    expect(result.current.stages.requests).toEqual([])
    unmount()
  })

  it('closes stages and moves the spotlight through the socket, and follows the host spotlight', () => {
    const videoRef: RefObject<HTMLVideoElement | null> = { current: null }
    const { result, unmount } = renderHook(() => useSync('r1', 'giuli', videoRef))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.onopen?.())

    act(() => { result.current.closeStage('screen', 'm3') })
    act(() => { result.current.setSpotlight({ kind: 'live' }) })
    act(() => { result.current.setSpotlight(null) })
    expect(sent(socket)).toEqual(expect.arrayContaining([
      { type: 'stageClose', kind: 'screen', targetId: 'm3' },
      { type: 'spotlight', kind: 'live' },
      { type: 'spotlight' },
    ]))

    expect(result.current.stages.spotlight).toBeUndefined()
    act(() => socket.receive({ type: 'spotlight', spotlight: { kind: 'screen', memberId: 'm3' } }))
    expect(result.current.stages.spotlight).toEqual({ kind: 'screen', memberId: 'm3' })
    act(() => socket.receive({ type: 'spotlight' }))
    expect(result.current.stages.spotlight).toBeNull()
    unmount()
  })
})
