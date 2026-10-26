import { act, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CallProvider, CallVideo } from './CallVideo'
import { useCall, type CallOptions } from './useCall'
import type { CallMember } from './plan'
import * as media from './media'

// jsdom has no WebTransport; the browser under test is one that can publish.
vi.mock('./moq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moq')>()),
  relayPublishSupported: () => true,
}))

vi.mock('./media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media')>()),
  fetchCallRelay: vi.fn(),
  publishCall: vi.fn(),
  openCallWatch: vi.fn(),
  openMic: vi.fn(),
  openCam: vi.fn(),
  localLevel: vi.fn(),
}))

const fakeTrack = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaStreamTrack

interface FakeMemberWatch {
  memberId: string
  audio: boolean
  canvas: HTMLCanvasElement | null
  levelValue: number
  audioAt: number | undefined
  audioReopened: number
  closed: boolean
}

let publisher: { ready: Promise<void>; setMic: ReturnType<typeof vi.fn<(track: MediaStreamTrack | undefined) => void>>; setCam: ReturnType<typeof vi.fn<(track: MediaStreamTrack | undefined) => void>>; close: ReturnType<typeof vi.fn<() => void>> }
let watches: FakeMemberWatch[]
let selfLevel: number

beforeEach(() => {
  localStorage.clear()
  watches = []
  selfLevel = 0
  publisher = { ready: Promise.resolve(), setMic: vi.fn(), setCam: vi.fn(), close: vi.fn() }
  vi.mocked(media.fetchCallRelay).mockResolvedValue({
    url: 'https://relay.test/sub', publishUrl: 'https://relay.test/pub', base: 'juntos/r1/s', path: 'juntos/r1/s/av/m1.hang',
  })
  vi.mocked(media.publishCall).mockResolvedValue(publisher)
  vi.mocked(media.openMic).mockImplementation(async () => fakeTrack('audio'))
  vi.mocked(media.openCam).mockImplementation(async () => fakeTrack('video'))
  vi.mocked(media.localLevel).mockImplementation(() => ({ level: () => selfLevel, close: vi.fn() }))
  vi.mocked(media.openCallWatch).mockResolvedValue({
    watch: (memberId: string) => {
      const watch: FakeMemberWatch = { memberId, audio: false, canvas: null, levelValue: 0, audioAt: undefined, audioReopened: 0, closed: false }
      watches.push(watch)
      return {
        status: { peek: () => 'live' as const, subscribe: () => () => undefined },
        setCanvas: (canvas) => { watch.canvas = canvas },
        setAudio: (enabled) => { watch.audio = enabled },
        setVolume: () => undefined,
        level: () => watch.levelValue,
        audioAt: () => watch.audioAt,
        reopenAudio: () => { watch.audioReopened += 1 },
        close: () => { watch.closed = true },
      }
    },
    setSpeaker: vi.fn(),
    close: vi.fn(),
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
  if (typeof globalThis.MediaStream === 'undefined') {
    vi.stubGlobal('MediaStream', class { tracks: MediaStreamTrack[]; constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks } getTracks() { return this.tracks } })
  }
})

const options = (overrides: Partial<CallOptions> = {}): CallOptions => ({
  roomId: 'r1', memberId: 'm1', capability: 'cap', send: vi.fn(), members: [{ id: 'm1' }], ...overrides,
})

const live = (watch: FakeMemberWatch | undefined) => watch && !watch.closed

describe('useCall', () => {
  it('turning the microphone on publishes it and tells the room', async () => {
    const send = vi.fn()
    const { result } = renderHook(() => useCall(options({ send })))
    await act(async () => { result.current.setMic(true) })
    await waitFor(() => expect(result.current.mic).toBe(true))
    await waitFor(() => expect(publisher.setMic).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'audio' })))
    expect(send).toHaveBeenLastCalledWith({ type: 'media', mic: true, cam: false })

    await act(async () => { result.current.setMic(false) })
    expect(result.current.mic).toBe(false)
    expect(publisher.setMic).toHaveBeenLastCalledWith(undefined)
    expect(send).toHaveBeenLastCalledWith({ type: 'media', mic: false, cam: false })
  })

  it('the camera shows up in my own preview', async () => {
    const { result } = renderHook(() => useCall(options()))
    await act(async () => { result.current.setCam(true) })
    await waitFor(() => expect(result.current.cam).toBe(true))
    expect(result.current.previewStream?.getTracks().map((track) => track.kind)).toEqual(['video'])
    await waitFor(() => expect(publisher.setCam).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'video' })))
  })

  it('the host turning my microphone off stops it and marks it forced until I turn it back on', async () => {
    const send = vi.fn()
    const { result } = renderHook(() => useCall(options({ send })))
    await act(async () => { result.current.setMic(true) })
    await waitFor(() => expect(result.current.mic).toBe(true))

    act(() => result.current.receive({ type: 'forceMedia', mic: false }))
    expect(result.current.mic).toBe(false)
    expect(result.current.forced).toEqual({ mic: true, cam: false })
    expect(publisher.setMic).toHaveBeenLastCalledWith(undefined)

    await act(async () => { result.current.setMic(true) })
    await waitFor(() => expect(result.current.mic).toBe(true))
    expect(result.current.forced).toEqual({ mic: false, cam: false })
  })

  it('hears everyone whose microphone is on and stops hearing whoever the host mutes', async () => {
    const members: CallMember[] = [{ id: 'm1' }, { id: 'm2', mic: true }, { id: 'm3' }]
    const { result, rerender } = renderHook((props: { members: CallMember[] }) => useCall(options(props)), { initialProps: { members } })
    await waitFor(() => expect(watches.find((watch) => watch.memberId === 'm2')?.audio).toBe(true))
    expect(watches.some((watch) => watch.memberId === 'm3')).toBe(false)
    expect(watches.some((watch) => watch.memberId === 'm1')).toBe(false)

    rerender({ members: [{ id: 'm1' }, { id: 'm2', mic: false, hostMuted: true }, { id: 'm3' }] })
    await waitFor(() => expect(watches[0].audio).toBe(false))
    expect(result.current.speaking).toEqual({})
    // The broadcast stays held while they are in the room: subscribing again
    // to one just left is what the relay is slowest to answer.
    expect(live(watches[0])).toBe(true)

    rerender({ members: [{ id: 'm1' }, { id: 'm3' }] })
    await waitFor(() => expect(live(watches[0])).toBe(false))
  })

  it('reopens a voice that stopped arriving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderHook(() => useCall(options({ members: [{ id: 'm1' }, { id: 'm2', mic: true }] })))
      await waitFor(() => expect(watches.length).toBe(1))
      watches[0].audioAt = 1_000
      await act(async () => { vi.advanceTimersByTime(3_000) })
      expect(watches[0].audioReopened).toBe(0)
      await act(async () => { vi.advanceTimersByTime(4_000) })
      // Only the voice starts over; the broadcast and its camera stay.
      expect(watches[0].audioReopened).toBe(1)
      expect(watches).toHaveLength(1)
      expect(watches[0].closed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lights whoever is speaking, me included', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = renderHook(() => useCall(options({ members: [{ id: 'm1' }, { id: 'm2', mic: true }] })))
      await act(async () => { result.current.setMic(true) })
      await waitFor(() => expect(watches.length).toBe(1))
      watches[0].levelValue = 0.2
      selfLevel = 0.2
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(result.current.speaking).toEqual({ m1: true, m2: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CallVideo', () => {
  function Harness({ members, children }: { members: CallMember[]; children: ReactNode }) {
    const call = useCall(options({ members }))
    return <CallProvider call={call}>{children}</CallProvider>
  }

  it('paints a member\'s camera on its canvas only while their camera is on', async () => {
    const members: CallMember[] = [{ id: 'm1' }, { id: 'm2', cam: true }]
    const view = render(<Harness members={members}><CallVideo memberId="m2" /></Harness>)
    await waitFor(() => expect(watches.find((watch) => watch.memberId === 'm2')?.canvas).toBeInstanceOf(HTMLCanvasElement))
    expect(watches[0].audio).toBe(false)

    view.rerender(<Harness members={[{ id: 'm1' }, { id: 'm2', cam: false, hostCamOff: true }]}><CallVideo memberId="m2" /></Harness>)
    await waitFor(() => expect(watches[0].canvas).toBeNull())
  })

  it('shows my own camera from the local preview, not the relay', async () => {
    const view = render(<Harness members={[{ id: 'm1', cam: true }]}><CallVideo memberId="m1" /></Harness>)
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(watches).toEqual([])
  })
})
