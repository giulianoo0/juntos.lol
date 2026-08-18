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
})
