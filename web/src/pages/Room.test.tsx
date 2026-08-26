import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './Room'
import { ToastProvider } from '../ui/Toast'
import { changeRoomSource, startUrlUpload } from '../upload'
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
  startUrlUpload: vi.fn(),
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

describe('RoomPage refetch under version churn', () => {
  const base = {
    id: 'abc123', fileName: 'movie.mkv', status: 'ready',
    sourceKind: 'upload', mediaGeneration: 0, controllerId: 'm1',
    audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
    memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
  }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lands a slow refetch even when more version signals arrive meanwhile', async () => {
    // During a torrent download the server announces fresh metadata every
    // second or so. On a connection where each round trip is slower than that
    // cadence, a refetch that gets cancelled by the next signal means no
    // response ever lands and the room stays frozen at its join-time state.
    const slow: Array<(json: unknown) => void> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) return Promise.resolve({ ok: true, status: 200, json: async () => base })
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        slow.push((json) => resolve({ ok: true, status: 200, json: async () => json }))
      })
    }))
    renderRoom()
    await screen.findByText('movie.mkv')
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    const socket = FakeWebSocket.instances[0]
    const signal = () => act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'roomUpdated' }) }) })

    signal()
    await waitFor(() => expect(slow.length).toBeGreaterThan(0))
    // The next signal arrives while that refetch is still in flight.
    signal()
    // The slow response finally lands and must not have been thrown away.
    act(() => slow[0]({ ...base, fileName: 'updated.mkv' }))

    await screen.findByText('updated.mkv')
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

    expect(await screen.findByRole('button', { name: /change media|trocar mídia/i })).toBeInTheDocument()
  })

  it('hides the swap from everyone who is not driving the room', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    // m2 is a viewer: the controller is m1.
    welcome('m2')

    await screen.findByRole('button', { name: /copy link|copiar link/i })
    expect(screen.queryByRole('button', { name: /change media|trocar mídia/i })).not.toBeInTheDocument()
  })

  it('repoints the room at a shared screen without anyone leaving', async () => {
    vi.mocked(requestScreenStream).mockResolvedValue(screenStream)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')

    fireEvent.click(await screen.findByRole('button', { name: /change media|trocar mídia/i }))
    fireEvent.click(await screen.findByRole('button', { name: /share screen|compartilhar tela/i }))

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

    fireEvent.click(await screen.findByRole('button', { name: /change media|trocar mídia/i }))
    fireEvent.click(await screen.findByRole('button', { name: /share screen|compartilhar tela/i }))

    // Nothing was swapped, so the room still plays what it played before.
    await waitFor(() => expect(requestScreenStream).toHaveBeenCalled())
    expect(changeRoomSource).not.toHaveBeenCalled()
    expect(stashScreenStream).not.toHaveBeenCalled()
  })
})

describe('RoomPage retomar o preparo', () => {
  // Resuming reopens the source on a fresh generation, and nothing already
  // produced survives that. It has to wait until the room is actually
  // pointing at media no region holds.
  const roomWith = (mediaRegions: unknown, producerHeartbeatMs?: number) => ({
    id: 'abc123', fileName: 'movie.mkv', status: 'ready',
    sourceKind: 'upload', mediaGeneration: 0, controllerId: 'm1',
    audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
    durationMs: 600_000, mediaRegions, producerHeartbeatMs,
    memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
  })

  const setup = (mediaRegions: unknown, producerHeartbeatMs?: number) => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    localStorage.setItem('ss.resume.abc123', JSON.stringify({
      kind: 'url', fileName: 'movie.mkv', url: 'https://example.test/movie.mkv', size: 10, savedAt: Date.now(),
    }))
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => roomWith(mediaRegions, producerHeartbeatMs) }))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const welcome = () => act(() => {
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        type: 'welcome', memberId: 'm1', controllerId: 'm1', capability: 'cap-token',
        members: [{ id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' }],
        state: { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 },
      }),
    })
  })

  it('leaves a room alone when a region already covers where it is', async () => {
    setup([{ n: 0, startMs: 0, producedMs: 600_000, growing: false }])
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome()

    await screen.findByRole('button', { name: /copy link|copiar link/i })
    expect(changeRoomSource).not.toHaveBeenCalled()
    expect(startUrlUpload).not.toHaveBeenCalled()
  })

  it('reopens the source when nothing holds the position the room is at', async () => {
    setup([{ n: 1, startMs: 500_000, producedMs: 100_000, growing: false }])
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome()

    await waitFor(() => expect(changeRoomSource).toHaveBeenCalled())
  })

  // The bug this guards: a cold seek puts the room somewhere no region holds
  // yet, which is exactly the shape of a dead room. Any tab holding a
  // resumable source — a second window, a viewer who once hosted this room —
  // would answer it by swapping the source for a fresh, empty generation and
  // throwing away everything the running pipeline had produced. A live
  // heartbeat says the pipeline is already on its way there.
  it('leaves a cold seek alone while a pipeline is still producing', async () => {
    setup([{ n: 1, startMs: 500_000, producedMs: 100_000, growing: false }], Date.now())
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome()

    await screen.findByRole('button', { name: /copy link|copiar link/i })
    expect(changeRoomSource).not.toHaveBeenCalled()
    expect(startUrlUpload).not.toHaveBeenCalled()
  })

  it('picks the room up once the pipeline behind it has gone quiet', async () => {
    setup([{ n: 1, startMs: 500_000, producedMs: 100_000, growing: false }], Date.now() - 10 * 60_000)
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome()

    await waitFor(() => expect(changeRoomSource).toHaveBeenCalled())
  })
})

describe('RoomPage header', () => {
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

  const chat = (author: string, text: string) => act(() => {
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        type: 'chat',
        message: { author, text, at: new Date().toISOString() },
      }),
    })
  })

  async function joinedRoom(memberId = 'm1') {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome(memberId)
    return await screen.findByRole('button', { name: /copy link|copiar link/i })
  }

  it('no longer offers screen sharing next to the source switcher', async () => {
    await joinedRoom()

    // Sharing a screen is what "change video" does; two entry points for it
    // only made the header longer.
    expect(screen.queryByRole('button', { name: /share screen|compartilhar tela/i })).not.toBeInTheDocument()
  })

  it('confirms a copied link with a toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const copy = await joinedRoom()

    fireEvent.click(copy)

    expect(writeText).toHaveBeenCalledWith('http://localhost/room/abc123')
    expect(await screen.findByText(/link copied|link copiado/i)).toBeInTheDocument()
    // The glyph is what confirms; the button keeps naming itself, so nobody
    // has to work out what a lone tick used to be.
    await waitFor(() => expect(copy.querySelector('.lucide-check')).toBeTruthy())
    expect(copy).toHaveAccessibleName(/copy link|copiar link/i)
  })

  it('counts messages that arrive while the chat is shut', async () => {
    await joinedRoom()
    const toggle = screen.getByRole('button', { name: /^chat$/i })

    // The chat starts open, so shut it before anything can go unread.
    fireEvent.click(toggle)
    chat('Ana', 'oi')
    chat('Ana', 'tudo bem?')

    expect(await screen.findByText('2')).toBeInTheDocument()
  })

  it('clears the count when the chat is opened', async () => {
    await joinedRoom()
    const toggle = screen.getByRole('button', { name: /^chat$/i })
    fireEvent.click(toggle)
    chat('Ana', 'oi')
    await screen.findByText('1')

    fireEvent.click(toggle)

    await waitFor(() => expect(screen.queryByText('1')).not.toBeInTheDocument())
  })

  it('gives the chat column back to the player when the chat is shut', async () => {
    const { container } = renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    welcome('m1')
    await screen.findByRole('button', { name: /copy link|copiar link/i })

    const layout = container.querySelector('.room-layout')!
    expect(layout).toHaveClass('chat-open')

    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }))

    expect(layout).not.toHaveClass('chat-open')
  })

  it('presents the synced start as a setting that is already on', async () => {
    await joinedRoom()

    const toggle = screen.getByRole('switch', { name: /force sync|forçar sincronizar/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(toggle)

    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'gating', enabled: false }),
    )
  })

  it('keeps the sync setting out of a viewer\'s header', async () => {
    await joinedRoom('m2')

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})

describe('RoomPage waiting screen', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const roomBody = (receivedBytes: number) => ({
    id: 'abc123', fileName: 'movie.mkv', status: 'uploading',
    sourceKind: 'upload', mediaGeneration: 0, controllerId: 'm1',
    audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
    memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
    preparation: {
      sourceBytes: 100 * 1024 * 1024,
      receivedBytes,
      previewPhase: 'receiving',
    },
  })

  it('keeps reading its own progress when no live update arrives', async () => {
    // A dropped WebSocket used to freeze this screen on the last figure it
    // heard, which looks identical to a transfer that died.
    let received = 10 * 1024 * 1024
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
      ok: true, status: 200, json: async () => roomBody(received),
    })))

    renderRoom()
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10'))

    received = 40 * 1024 * 1024
    // No socket frame is delivered: only the poll can move this.
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'),
      { timeout: 6000 })
  }, 10_000)
})

describe('RoomPage waiting panel', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.nickname', 'Giuli')
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        id: 'abc123', fileName: 'movie.mkv', status: 'ready',
        sourceKind: 'upload', mediaGeneration: 0, controllerId: 'm1',
        audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
        memberCount: 2, expiresAt: '2099-01-01T00:00:00Z',
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Presence toasts are role=status too, so the panel is found by its own
  // heading rather than by role alone.
  const waitingPanel = async () => {
    const heading = await screen.findByText(/everyone to buffer|todo mundo/i)
    return heading.closest('.waiting-panel') as HTMLElement
  }

  const joinAndWait = (memberId: string, readiness: Array<Record<string, unknown>>) => {
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'welcome', memberId, controllerId: 'm1', capability: 'cap-token',
          members: [
            { id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' },
            { id: 'm2', nickname: 'Ana', joinedAt: '2026-01-01T00:00:00Z' },
          ],
          state: { playing: false, positionMs: 30000, rate: 1, serverTimeMs: 0 },
        }),
      })
    })
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'waiting', targetMs: 30000, readiness }),
      })
    })
  }

  it('offers Ignore to the controller for whoever is holding the room up', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    joinAndWait('m1', [
      { memberId: 'm1', bufferAheadMs: 5000, ready: true },
      { memberId: 'm2', bufferAheadMs: 0, ready: false, stalled: true },
    ])

    const panel = await waitingPanel()
    expect(within(panel).getByText('Ana')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: /ignore|ignorar/i }))

    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ignore', targetId: 'm2' }),
    )
  })

  it('does not offer Ignore for members who are already ready', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    joinAndWait('m1', [
      { memberId: 'm1', bufferAheadMs: 5000, ready: true },
      { memberId: 'm2', bufferAheadMs: 5000, ready: true },
    ])

    const panel = await waitingPanel()
    expect(within(panel).getByText('Ana')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /ignore|ignorar/i })).not.toBeInTheDocument()
  })

  it('keeps Ignore away from viewers', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    // m2 is a viewer; the controller is m1.
    joinAndWait('m2', [
      { memberId: 'm1', bufferAheadMs: 0, ready: false, stalled: true },
      { memberId: 'm2', bufferAheadMs: 5000, ready: true },
    ])

    const panel = await waitingPanel()
    expect(within(panel).getByText('Giuli')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /ignore|ignorar/i })).not.toBeInTheDocument()
  })

  it('shows an ignored member as watching separately, with no button', async () => {
    renderRoom()
    await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
    joinAndWait('m1', [
      { memberId: 'm1', bufferAheadMs: 5000, ready: true },
      { memberId: 'm2', bufferAheadMs: 0, ready: true, stalled: true, ignored: true },
    ])

    const panel = await waitingPanel()
    expect(within(panel).getByText(/watching on their own|assistindo por conta/i)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /ignore|ignorar/i })).not.toBeInTheDocument()
  })
})
