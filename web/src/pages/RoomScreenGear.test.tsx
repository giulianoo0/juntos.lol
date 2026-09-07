import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './Room'
import { ToastProvider } from '../ui/Toast'
import { changeRoomSource } from '../upload'
import {
  fetchScreenRelay,
  isScreenShareCancelled,
  publishScreen,
  setScreenLive,
} from '../screenshare'
import {
  fetchJLocalWindows,
  isJLocalAudioCaptureAvailable,
  setJLocalAppMuted,
  setJLocalAudioMode,
} from '../jlocal/audio'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'

vi.mock('../screenshare', () => ({
  screenShareSupported: vi.fn().mockReturnValue(true),
  fetchScreenRelay: vi.fn().mockResolvedValue({ url: 'https://relay.test/token', path: 'juntos/abc123/secret.hang', publish: true }),
  publishScreen: vi.fn().mockResolvedValue({ status: { peek: () => 'connected', subscribe: () => () => undefined }, ready: Promise.resolve(), close: vi.fn() }),
  watchScreen: vi.fn().mockResolvedValue({ status: { peek: () => 'offline', subscribe: () => () => undefined }, close: vi.fn() }),
  setScreenLive: vi.fn().mockResolvedValue(undefined),
  requestScreenStream: vi.fn(),
  stashScreenStream: vi.fn(),
  takeScreenStream: vi.fn().mockReturnValue(null),
  dropScreenStream: vi.fn(),
  isScreenShareCancelled: vi.fn().mockReturnValue(false),
}))
vi.mock('../upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../upload')>()),
  changeRoomSource: vi.fn().mockResolvedValue({
    status: 'uploading', sourceKind: 'upload', fileName: 'next.mkv',
    mediaGeneration: 1, uploadEndpoint: '/api/upload/', streamStartBytes: 1024,
  }),
}))
vi.mock('../jlocal/capabilities', () => ({
  isJLocalCaptureAvailable: vi.fn().mockReturnValue(true),
}))
vi.mock('../jlocal/audio', () => ({
  setJLocalAudioMode: vi.fn().mockResolvedValue(undefined),
  setJLocalAppMuted: vi.fn().mockResolvedValue(undefined),
  fetchJLocalWindows: vi.fn().mockResolvedValue([]),
  isJLocalAudioCaptureAvailable: vi.fn().mockReturnValue(false),
}))
vi.mock('../jlocal/screenFeed', () => ({
  startJLocalScreenFeed: vi.fn(),
}))

const modalSeen = vi.hoisted(() => ({ props: [] as Array<{ open: boolean; onConfirm: (stream: MediaStream, stop: () => void, choice?: unknown) => void; onUseBrowser: () => void }> }))
vi.mock('../components/JLocalScreen', () => ({
  JLocalScreenModal: (props: {
    open: boolean
    onConfirm: (stream: MediaStream, stop: () => void, choice?: unknown) => void
    onUseBrowser: () => void
  }) => {
    modalSeen.props.push(props)
    return props.open ? <div data-testid="jscreen-stub" /> : null
  },
  jlocalQualityOptions: () => [
    { id: '1080p', width: 1920, height: 1080 },
    { id: '4K', width: 3840, height: 2160 },
  ],
  jlocalFpsOptions: () => [24, 30, 60],
}))

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() { FakeWebSocket.instances.push(this) }
}

function renderRoom() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/room/abc123']}>
        <Routes><Route path="/room/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

function fakeTrack() {
  return { enabled: true, stop: vi.fn(), addEventListener: vi.fn() }
}

function fakeStream(withAudio: boolean) {
  const video = fakeTrack()
  const audio = fakeTrack()
  const tracks = withAudio ? [video, audio] : [video]
  return {
    stream: {
      getTracks: () => tracks,
      getVideoTracks: () => [video],
      getAudioTracks: () => (withAudio ? [audio] : []),
    } as unknown as MediaStream,
    video,
    audio,
    tracks,
  }
}

const screenRoom = {
  id: 'abc123', fileName: 'Shared screen', status: 'ready',
  sourceKind: 'screen', mediaGeneration: 0, controllerId: 'm1',
  audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
  memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
}

const welcome = (memberId: string) => act(() => {
  FakeWebSocket.instances[0].onmessage?.({
    data: JSON.stringify({
      type: 'welcome', memberId, controllerId: 'm1', capability: 'cap-token',
      members: [{ id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' }],
      state: { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 },
    }),
  })
})

describe('RoomPage screen gear', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    modalSeen.props = []
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => screenRoom,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the gear for the controller only', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    expect(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
      .toBeInTheDocument()
  })

  it('keeps the gear away from viewers', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m2')

    await screen.findByText(/waiting for the host|esperando o anfitrião/i)
    expect(screen.queryByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
      .not.toBeInTheDocument()
  })

  it('swaps the publish on repick confirm', async () => {
    const first = fakeStream(false)
    const second = fakeStream(true)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i }))
    await screen.findByTestId('jscreen-stub')
    const stopFirst = vi.fn()
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(first.stream, stopFirst) })
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(1))
    expect(publishScreen).toHaveBeenCalledWith(expect.anything(), first.stream)

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    fireEvent.click(await screen.findByRole('button', { name: /switch source|trocar fonte/i }))
    await screen.findByTestId('jscreen-stub')

    const stopSecond = vi.fn()
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(second.stream, stopSecond) })

    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(2))
    expect(publishScreen).toHaveBeenLastCalledWith(expect.anything(), second.stream)
    // The old stream is released by the swap, and the room is marked live again.
    expect(first.video.stop).toHaveBeenCalled()
    await waitFor(() => expect(setScreenLive).toHaveBeenLastCalledWith('abc123', 'm1', 'cap-token', true))
    expect(changeRoomSource).not.toHaveBeenCalled()
  })
  it('toggles the master sound off live', async () => {
    vi.mocked(isJLocalAudioCaptureAvailable).mockReturnValue(true)
    const live = fakeStream(true)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i }))
    await screen.findByTestId('jscreen-stub')
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(live.stream, vi.fn()) })
    await waitFor(() => expect(publishScreen).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    const master = await screen.findByRole('switch', { name: /system sound|som do sistema/i })
    expect(master).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(master)

    expect(vi.mocked(setJLocalAudioMode)).toHaveBeenCalledWith('none')
    expect(live.audio.enabled).toBe(false)
    expect(await screen.findByRole('switch', { name: /system sound|som do sistema/i }))
      .toHaveAttribute('aria-checked', 'false')
  })

  it('dedupes windows by app and mutes through custom mode', async () => {
    vi.mocked(isJLocalAudioCaptureAvailable).mockReturnValue(true)
    vi.mocked(fetchJLocalWindows).mockResolvedValue([
      { id: '1', app: 'Music', name: 'Music' },
      { id: '2', app: 'Music', name: 'Music — B-side' },
      { id: '3', app: 'Browser', name: 'Browser' },
    ])
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')
    await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i })

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))

    const music = await screen.findByRole('switch', { name: 'Music' })
    expect(screen.getAllByRole('switch', { name: 'Music' })).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Browser' })).toBeInTheDocument()

    fireEvent.click(music)

    // The first per-app choice implies custom mode, then persists the mute.
    await waitFor(() => expect(vi.mocked(setJLocalAudioMode)).toHaveBeenCalledWith('custom'))
    expect(vi.mocked(setJLocalAppMuted)).toHaveBeenCalledWith('Music', true)
    expect(fetchScreenRelay).not.toHaveBeenCalled()
    expect(isScreenShareCancelled).not.toHaveBeenCalled()
  })

  it('hides every sound control when audio capture is off', async () => {
    vi.mocked(isJLocalAudioCaptureAvailable).mockReturnValue(false)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')
    await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i })

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    await screen.findByRole('button', { name: /switch source|trocar fonte/i })

    expect(screen.queryByRole('switch', { name: /system sound|som do sistema/i })).not.toBeInTheDocument()
    expect(vi.mocked(fetchJLocalWindows)).not.toHaveBeenCalled()
  })

  it('restarts the same target at a new framerate without repicking', async () => {
    const live = fakeStream(false)
    const next = fakeStream(false)
    const stopFirst = vi.fn()
    const stopNext = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream: next.stream, stop: stopNext })
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i }))
    await screen.findByTestId('jscreen-stub')
    const choice = { target: { kind: 'display', id: '1' }, qualityId: '1080p', width: 1920, height: 1080, fps: 30, audio: false }
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(live.stream, stopFirst, choice) })
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    fireEvent.click(await screen.findByRole('radio', { name: '60 fps' }))

    await waitFor(() => expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '1' },
      { width: 1920, height: 1080, fps: 60, audio: false },
    ))
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(2))
    expect(publishScreen).toHaveBeenLastCalledWith(expect.anything(), next.stream)
    expect(stopFirst).toHaveBeenCalled()
    expect(live.video.stop).toHaveBeenCalled()
  })

  it('restarts the same target at a new quality without repicking', async () => {
    const live = fakeStream(false)
    const next = fakeStream(false)
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream: next.stream, stop: vi.fn() })
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i }))
    await screen.findByTestId('jscreen-stub')
    const choice = { target: { kind: 'display', id: '1' }, qualityId: '1080p', width: 1920, height: 1080, fps: 30, audio: false }
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(live.stream, vi.fn(), choice) })
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    // Current quality is checked and disabled; the other preset switches.
    expect(screen.getByRole('radio', { name: '1080p' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: '4K' }))

    await waitFor(() => expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '1' },
      { width: 3840, height: 2160, fps: 30, audio: false },
    ))
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(2))
  })

  it('applies native framerate live on the track', async () => {
    const video = { ...fakeTrack(), applyConstraints: vi.fn().mockResolvedValue(undefined), getSettings: () => ({ frameRate: 30 }) }
    const stream = {
      getTracks: () => [video],
      getVideoTracks: () => [video],
      getAudioTracks: () => [],
    } as unknown as MediaStream
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /share my screen|compartilhar minha tela/i }))
    await screen.findByTestId('jscreen-stub')
    // Native confirm: no feed choice, so fps applies on the track.
    act(() => { modalSeen.props[modalSeen.props.length - 1]?.onConfirm(stream, vi.fn()) })
    await waitFor(() => expect(publishScreen).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: /screen share settings|configurações do compartilhamento/i }))
    fireEvent.click(await screen.findByRole('radio', { name: '60 fps' }))

    await waitFor(() => expect(video.applyConstraints).toHaveBeenCalledWith({ frameRate: { ideal: 60 } }))
    expect(publishScreen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startJLocalScreenFeed)).not.toHaveBeenCalled()
  })
})
