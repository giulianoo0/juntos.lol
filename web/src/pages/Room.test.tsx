import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './Room'
import { changeRoomSource } from '../upload'
import { isScreenShareCancelled, requestScreenStream, stashScreenStream } from '../screenshare'

const screenStream = { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream
vi.mock('../screenshare', () => ({
  startScreenShare: vi.fn().mockResolvedValue({ disconnect: vi.fn() }),
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
    <MemoryRouter initialEntries={['/room/abc123']}>
      <Routes><Route path="/room/:id" element={<RoomPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('RoomPage join screen', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'abc123',
        fileName: 'movie.mkv',
        status: 'uploading',
        sourceKind: 'upload',
        mediaGeneration: 0,
        controllerId: 'm1',
        audioTracks: null,
        subtitleTracks: null,
        bitmapSubsSkipped: 0,
        memberCount: 1,
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('asks for a name and nothing else when the room is opened from a link', async () => {
    renderRoom()

    // The link already grants access, so the only prompt is the display name.
    const field = await screen.findByLabelText(/your name|seu nome/i)
    expect(field).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /what should we call you|como devemos chamar você/i })).toBeInTheDocument()
    expect(document.querySelectorAll('input')).toHaveLength(1)
  })

  it('joins with the typed name when the field is submitted', async () => {
    renderRoom()

    const field = await screen.findByLabelText(/your name|seu nome/i)
    fireEvent.change(field, { target: { value: '  Giuli  ' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(() => expect(localStorage.getItem('ss.nickname')).toBe('Giuli'))
    expect(screen.queryByRole('heading', { name: /what should we call you|como devemos chamar você/i })).not.toBeInTheDocument()
  })

  it('accepts an empty name and falls back to a generated guest name', async () => {
    renderRoom()

    const field = await screen.findByLabelText(/your name|seu nome/i)
    fireEvent.submit(field.closest('form')!)

    await waitFor(() => expect(localStorage.getItem('ss.nickname')).toMatch(/^Guest-[A-Za-z0-9]{6}$/))
  })

  it('skips the prompt entirely for someone who already has a name', async () => {
    localStorage.setItem('ss.nickname', 'Giuli')
    renderRoom()

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByLabelText(/your name|seu nome/i)).not.toBeInTheDocument()
  })
})

describe('RoomPage source swap', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'abc123', fileName: 'movie.mkv', status: 'ready',
        sourceKind: 'upload', mediaGeneration: 0, controllerId: 'm1',
        audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
        memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const welcome = (memberId: string) => act(() => {
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        type: 'welcome', memberId, controllerId: 'm1', capability: 'cap-token',
        members: [{ id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' }],
        state: { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 },
      }),
    })
  })

  it('offers the swap to the controller only', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    expect(await screen.findByRole('button', { name: /change video|trocar vídeo/i })).toBeInTheDocument()
  })

  it('hides the swap from everyone who is not driving the room', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    // m2 is a viewer: the controller is m1.
    welcome('m2')

    await screen.findByRole('button', { name: /copy link|copiar link/i })
    expect(screen.queryByRole('button', { name: /change video|trocar vídeo/i })).not.toBeInTheDocument()
  })

  it('repoints the room at a shared screen without anyone leaving', async () => {
    vi.mocked(requestScreenStream).mockResolvedValue(screenStream)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /change video|trocar vídeo/i }))
    fireEvent.click(await screen.findByRole('button', { name: /share your screen|compartilhar sua tela/i }))

    // The screen is granted first, then carried into the room it will play in.
    await waitFor(() => expect(changeRoomSource).toHaveBeenCalledWith('abc123', 'm1', 'cap-token', 'screen'))
    expect(requestScreenStream).toHaveBeenCalled()
    expect(stashScreenStream).toHaveBeenCalledWith('abc123', screenStream)
  })

  it('leaves the room untouched when the screen picker is dismissed', async () => {
    const cancelled = new DOMException('denied', 'NotAllowedError')
    vi.mocked(requestScreenStream).mockRejectedValue(cancelled)
    vi.mocked(isScreenShareCancelled).mockReturnValue(true)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /change video|trocar vídeo/i }))
    fireEvent.click(await screen.findByRole('button', { name: /share your screen|compartilhar sua tela/i }))

    // Nothing was swapped, so the room still plays what it played before.
    await waitFor(() => expect(requestScreenStream).toHaveBeenCalled())
    expect(changeRoomSource).not.toHaveBeenCalled()
    expect(stashScreenStream).not.toHaveBeenCalled()
  })
})
