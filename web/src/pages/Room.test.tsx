import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './Room'
import { ToastProvider } from '../ui/Toast'
import { changeRoomSource, startUrlUpload } from '../upload'
import { requestScreenStream } from '../screenshare'
import { desktop, resetDesktopForTests } from '../platform'

vi.mock('../screenshare', () => ({
  screenShareSupported: vi.fn().mockReturnValue(true),
  displayCaptureAvailable: vi.fn().mockReturnValue(true),
  fetchScreenRelay: vi.fn().mockResolvedValue({
    url: 'https://relay.test/token', base: 'juntos/abc123/secret', path: 'juntos/abc123/secret/m1.hang', publish: true, open: true,
  }),
  publishScreen: vi.fn().mockResolvedValue({ status: { peek: () => 'connected', subscribe: () => () => undefined }, ready: Promise.resolve(), close: vi.fn() }),
  watchScreen: vi.fn().mockResolvedValue({
    status: { peek: () => 'offline', subscribe: () => () => undefined }, muted: { set: vi.fn() }, close: vi.fn(),
  }),
  setScreenLive: vi.fn().mockResolvedValue(undefined),
  screenPath: (base: string, memberId: string) => `${base}/${memberId}.hang`,
  loadScreenQuality: vi.fn().mockReturnValue('auto'),
  saveScreenQuality: vi.fn(),
  SCREEN_QUALITIES: [{ id: 'auto' }],
  screenQuality: (id: string) => ({ id, label: id }),
  requestScreenStream: vi.fn(),
  stashScreenStream: vi.fn(),
  takeScreenStream: vi.fn().mockReturnValue(null),
  dropScreenStream: vi.fn(),
  isScreenShareCancelled: vi.fn().mockReturnValue(false),
}))
vi.mock('../upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../upload')>()),
  changeRoomSource: vi.fn().mockResolvedValue({
    status: 'uploading', fileName: 'next.mkv',
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

const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
const receive = (message: unknown) => act(() => { socket().onmessage?.({ data: JSON.stringify(message) }) })
const sent = () => socket().send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>)

const roomBody = (extra: Record<string, unknown> = {}) => ({
  id: 'abc123', fileName: 'movie.mkv', status: 'ready',
  mediaGeneration: 0, controllerId: 'm1',
  audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0,
  memberCount: 1, expiresAt: '2099-01-01T00:00:00Z',
  ...extra,
})

type Reply = { status?: number; body?: unknown }
const json = ({ status = 200, body = {} }: Reply) => Promise.resolve({ ok: status < 400, status, json: async () => body })

/** The room's three doors: its preview, its info and the password's ticket. */
function serve({ room = roomBody(), preview = {}, join }: {
  room?: unknown | (() => unknown)
  preview?: Record<string, unknown>
  join?: Reply
} = {}) {
  const fetchMock = vi.fn((url: string) => {
    const path = String(url)
    if (path.endsWith('/preview')) return json({ body: { joinMode: 'open', memberCount: 1, nicknames: ['Giuli'], ...preview } })
    if (path.endsWith('/join')) return json(join ?? { body: { ticket: 't1' } })
    if (path.startsWith('/api/rooms/')) return json({ body: typeof room === 'function' ? room() : room })
    return json({ status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderRoom() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/room/abc123']}>
        <RoomPage id="abc123" onInCall={() => {}} />
      </MemoryRouter>
    </ToastProvider>,
  )
}

const nameField = () => screen.findByLabelText('Seu nome')
const joinButton = () => screen.getByRole('button', { name: 'Entrar' })

async function enter(name = 'Giuli') {
  fireEvent.change(await nameField(), { target: { value: name } })
  fireEvent.click(joinButton())
  await waitFor(() => expect(FakeWebSocket.instances).not.toHaveLength(0))
}

const welcome = (memberId: string, members = [{ id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' }]) => receive({
  type: 'welcome', memberId, controllerId: 'm1', capability: 'cap-token', members,
  state: { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 },
})

async function joined(memberId = 'm1') {
  renderRoom()
  await enter()
  welcome(memberId)
  await screen.findByRole('button', { name: 'Copiar link da sala' })
}

async function pickShare(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('entrada da sala', () => {
  it('guarda o lugar da porta enquanto a prévia da sala não chega', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/me' ? json({ status: 401 }) : new Promise(() => {})))
    renderRoom()

    const door = screen.getByRole('status')
    expect(door).toHaveAttribute('aria-busy', 'true')
    expect(door).toHaveTextContent(/^Carregando$/)
  })

  it('entra com o nome digitado, sem os espaços', async () => {
    serve()
    renderRoom()

    await enter('  Giuli  ')

    expect(localStorage.getItem('ss.nickname')).toBe('Giuli')
    expect(screen.queryByLabelText('Seu nome')).not.toBeInTheDocument()
  })

  it('deixa entrar sem nome e vira convidado', async () => {
    serve()
    renderRoom()
    await nameField()

    fireEvent.click(joinButton())

    await waitFor(() => expect(localStorage.getItem('ss.nickname')).toMatch(/^Guest-[A-Za-z0-9]{6}$/))
  })

  it('traz preenchido o nome de quem já entrou antes', async () => {
    localStorage.setItem('ss.nickname', 'Giuli')
    serve()
    renderRoom()

    expect(await nameField()).toHaveValue('Giuli')
  })
})

describe('porta com senha', () => {
  it('troca a senha por um ticket antes de abrir o socket', async () => {
    const fetchMock = serve({ preview: { joinMode: 'password' } })
    renderRoom()
    fireEvent.change(await screen.findByLabelText('Senha da sala'), { target: { value: 'pipoca' } })

    await enter()

    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/abc123/join', expect.objectContaining({ body: JSON.stringify({ password: 'pipoca' }) }))
    expect(sessionStorage.getItem('ss.join-ticket.abc123')).toBe('t1')
  })

  it.each([
    ['bad_password', 'Senha errada'],
    ['too_many_attempts', 'Muitas tentativas. Espere um pouco'],
  ])('fica na porta e explica um %s', async (code, message) => {
    serve({ preview: { joinMode: 'password' }, join: { status: 403, body: { error: code } } })
    renderRoom()
    fireEvent.change(await screen.findByLabelText('Senha da sala'), { target: { value: 'errada' } })
    fireEvent.change(await nameField(), { target: { value: 'Giuli' } })

    fireEvent.click(joinButton())

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('o botão de entrar trabalha com o mesmo nome enquanto confere a senha', async () => {
    serve({ preview: { joinMode: 'password' } })
    vi.mocked(fetch).mockImplementation(((url: string) => String(url).endsWith('/join') ? new Promise(() => {}) : json({ body: { joinMode: 'password', memberCount: 1, nicknames: ['Giuli'] } })) as never)
    renderRoom()
    fireEvent.change(await screen.findByLabelText('Senha da sala'), { target: { value: 'pipoca' } })
    fireEvent.click(joinButton())

    await waitFor(() => expect(joinButton()).toHaveAttribute('aria-busy', 'true'))
    expect(joinButton()).toBeDisabled()
  })

  it('volta para a senha quando o socket recusa o ticket', async () => {
    serve()
    renderRoom()
    await enter()

    receive({ type: 'error', error: 'bad_ticket' })

    expect(await screen.findByLabelText(/^Senha da sala/)).toBeInTheDocument()
    expect(screen.getByText('Senha errada')).toBeInTheDocument()
  })
})

describe('sala com aprovação', () => {
  it('espera o host na porta até ser admitido', async () => {
    serve({ preview: { joinMode: 'approval' } })
    renderRoom()
    await enter()

    receive({ type: 'lobby' })
    expect(await screen.findByText('Esperando o host deixar você entrar')).toBeInTheDocument()

    welcome('m2')
    expect(await screen.findByRole('button', { name: 'Copiar link da sala' })).toBeInTheDocument()
  })

  it('mostra ao host quem bate e manda a resposta', async () => {
    serve()
    await joined('m1')

    receive({ type: 'knock', requestId: 'k1', nickname: 'Ana' })
    fireEvent.click(await screen.findByRole('button', { name: 'Deixar entrar' }))

    expect(sent()).toContainEqual(expect.objectContaining({ type: 'admit', targetId: 'k1' }))
  })
})

describe('versão da sala', () => {
  it('aplica um refetch lento mesmo com novos sinais de versão no meio', async () => {
    const slow: Array<(body: unknown) => void> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/preview')) return json({ body: { joinMode: 'open', memberCount: 0, nicknames: [] } })
      if (!path.startsWith('/api/rooms/')) return json({ status: 404 })
      calls += 1
      if (calls === 1) return json({ body: roomBody() })
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        slow.push((body) => resolve({ ok: true, status: 200, json: async () => body }))
      })
    }))
    await joined()
    const roomUpdated = () => receive({ type: 'roomUpdated' })

    await waitFor(() => expect(slow.length).toBeGreaterThan(0))
    roomUpdated()
    act(() => slow[0](roomBody({ fileName: 'updated.mkv' })))

    expect(await screen.findByRole('heading', { name: 'updated.mkv' })).toBeInTheDocument()
  })
})

describe('retomar o preparo', () => {
  const resumable = () => localStorage.setItem('ss.resume.abc123', JSON.stringify({
    kind: 'url', fileName: 'movie.mkv', url: 'https://example.test/movie.mkv', size: 10, savedAt: Date.now(),
  }))
  const gap = [{ n: 1, startMs: 500_000, producedMs: 100_000, growing: false }]

  it.each([
    ['uma região já cobre a posição', [{ n: 0, startMs: 0, producedMs: 600_000, growing: false }], undefined],
    ['um pipeline ainda produz', gap, () => Date.now()],
  ])('deixa a sala quieta quando %s', async (_, mediaRegions, heartbeat) => {
    resumable()
    serve({ room: () => roomBody({ durationMs: 600_000, mediaRegions, producerHeartbeatMs: heartbeat?.() }) })

    await joined()

    expect(changeRoomSource).not.toHaveBeenCalled()
    expect(startUrlUpload).not.toHaveBeenCalled()
  })

  it.each([
    ['nada cobre a posição da sala', undefined],
    ['o pipeline ficou quieto', () => Date.now() - 10 * 60_000],
  ])('reabre a fonte quando %s', async (_, heartbeat) => {
    resumable()
    serve({ room: () => roomBody({ durationMs: 600_000, mediaRegions: gap, producerHeartbeatMs: heartbeat?.() }) })

    await joined()

    await waitFor(() => expect(startUrlUpload).toHaveBeenCalledWith('abc123', 1, 'https://example.test/movie.mkv', 'movie.mkv', 10))
  })
})

describe('pedido de palco', () => {
  it('convidado pede um palco ao host e abre o seletor quando ele deixa', async () => {
    serve()
    await joined('m2')

    await pickShare('Torrent')
    expect(sent()).toContainEqual({ type: 'stageRequest', kind: 'media' })
    expect(screen.queryByRole('textbox', { name: 'Magnet link' })).not.toBeInTheDocument()

    receive({ type: 'stageGrant', kind: 'media', allow: true })
    expect(await screen.findByRole('textbox', { name: 'Magnet link' })).toBeInTheDocument()
  })

  it('mostra ao host o pedido do convidado e manda a resposta', async () => {
    serve()
    await joined('m1')
    receive({ type: 'stageRequest', requestId: 'q1', memberId: 'm2', nickname: 'Ana', kind: 'screen' })

    fireEvent.click(await screen.findByRole('button', { name: 'Permitir' }))

    expect(sent()).toContainEqual({ type: 'stageAnswer', requestId: 'q1', allow: true })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Permitir' })).not.toBeInTheDocument())
  })
})

describe('palcos', () => {
  it('põe a tela compartilhada ao lado da mídia, sem trocar a fonte', async () => {
    serve({ room: roomBody({ screens: [{ memberId: 'm2', nickname: 'Ana', since: '2026-01-01T00:00:00Z' }] }) })
    await joined('m1')

    expect(await screen.findByRole('button', { name: 'Fixar: Tela de Ana' })).toBeInTheDocument()
    expect(changeRoomSource).not.toHaveBeenCalled()
  })
})

describe('espera para começar junto', () => {
  const waiting = (memberId: string, readiness: Array<Record<string, unknown>>) => {
    welcome(memberId, [
      { id: 'm1', nickname: 'Giuli', joinedAt: '2026-01-01T00:00:00Z' },
      { id: 'm2', nickname: 'Ana', joinedAt: '2026-01-01T00:00:00Z' },
    ])
    receive({ type: 'waiting', targetMs: 30000, readiness })
  }
  const panel = async () => (await screen.findByText('Esperando todo mundo carregar')).closest('[role="status"]') as HTMLElement

  it('deixa o host ignorar quem segura a sala', async () => {
    serve()
    renderRoom()
    await enter()
    waiting('m1', [
      { memberId: 'm1', bufferAheadMs: 5000, ready: true },
      { memberId: 'm2', bufferAheadMs: 0, ready: false, stalled: true },
    ])

    fireEvent.click(within(await panel()).getByRole('button', { name: 'Ignorar' }))

    expect(sent()).toContainEqual({ type: 'ignore', targetId: 'm2' })
  })

  it.each([
    ['quem já está pronto', 'm1', { memberId: 'm2', bufferAheadMs: 5000, ready: true }],
    ['quem já foi ignorado', 'm1', { memberId: 'm2', bufferAheadMs: 0, ready: true, stalled: true, ignored: true }],
    ['um convidado', 'm2', { memberId: 'm1', bufferAheadMs: 0, ready: false, stalled: true }],
  ])('não oferece Ignorar para %s', async (_, self, other) => {
    serve()
    renderRoom()
    await enter()
    waiting(self, [{ memberId: self, bufferAheadMs: 5000, ready: true }, other])

    expect(within(await panel()).queryByRole('button', { name: 'Ignorar' })).not.toBeInTheDocument()
  })
})

describe('preparo', () => {
  it('acompanha o progresso sozinho quando o socket não traz novidade', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let received = 10 * 1024 * 1024
    serve({ room: () => roomBody({
      status: 'uploading',
      preparation: { sourceBytes: 100 * 1024 * 1024, receivedBytes: received, previewPhase: 'receiving' },
    }) })
    renderRoom()
    await enter()
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10'))

    received = 40 * 1024 * 1024
    await act(() => vi.advanceTimersByTimeAsync(3_000))

    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'))
  })
})

describe('tela pelo app', () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    resetDesktopForTests()
  })

  it('no app que captura, Tela abre o seletor do app e não o do navegador', async () => {
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.2.0', compatible: true, features: ['screenCapture'], mediaRoot: 'juntos-media://localhost' }
        if (cmd === 'screen_sources') return { displays: [{ id: 'd1', name: 'Tela 1', width: 1920, height: 1080 }], windows: [] }
        if (cmd === 'audio_apps') return [{ id: 'discord', name: 'Discord' }]
        return null
      },
    }
    resetDesktopForTests()
    await desktop()
    serve()
    await joined()

    await pickShare('Tela')
    expect(await screen.findByRole('switch', { name: 'Discord' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('region', { name: 'Som' })).toBeInTheDocument()
    expect(requestScreenStream).not.toHaveBeenCalled()
  })
})

describe('cópia própria no app', () => {
  const magnet = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Ma%C3%A7%C3%A3'
  const meta = { key: 't-abc-2', title: 'Maçã', durationMs: 600000, audioLangs: ['por'], videoCodecs: null, regions: [] }
  let invoke: ReturnType<typeof vi.fn>
  let produced: number

  const localRoom = (extra: Record<string, unknown> = {}) => roomBody({
    fileName: 'Maçã', status: 'local', mediaGeneration: 3, localSource: true, sourceMemberId: 'm1',
    localCopy: { kind: 'torrent', magnet, index: 2 }, ...extra,
  })
  const calls = (name: string) => invoke.mock.calls.filter(([cmd]) => cmd === name).map(([, args]) => args)
  const failures = () => sent().filter((message) => message.type === 'localCopyFailed')

  beforeEach(async () => {
    produced = 0
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.2.1', compatible: true, features: [], mediaRoot: 'juntos-media://localhost' }
      if (cmd === 'torrent_open') return { id: 'abc', name: 'Maçã', files: [] }
      if (cmd === 'local_prepare') return meta
      if (cmd === 'local_regions') return [{ n: 0, startMs: 0, producedMs: produced, growing: true }]
      return null
    })
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke }
    resetDesktopForTests()
    await desktop()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    resetDesktopForTests()
  })

  it('o convidado no app abre o mesmo torrent e o mesmo arquivo, sem pedir o bucket', async () => {
    serve({ room: localRoom() })
    await joined('m2')

    await waitFor(() => expect(calls('local_prepare')).toEqual([{ source: { kind: 'torrent', id: 'abc', index: 2, title: 'Maçã' } }]))
    expect(calls('torrent_open')).toEqual([{ magnet }])
    expect(failures()).toEqual([])
  })

  it('quem abriu a fonte não abre uma cópia dela', async () => {
    serve({ room: localRoom({ sourceMemberId: 'm1' }) })
    await joined('m1')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls('torrent_open')).toEqual([])
    expect(failures()).toEqual([])
  })

  it('sem o que abrir, o convidado avisa a sala e fica com o bucket', async () => {
    serve({ room: localRoom({ localCopy: null }) })
    await joined('m2')

    await waitFor(() => expect(failures()).toEqual([{ type: 'localCopyFailed', generation: 3 }]))
    expect(calls('torrent_open')).toEqual([])
  })

  it('um torrent que não abre vira o bucket', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'torrent_open') throw new Error('invalid magnet')
      return null
    })
    serve({ room: localRoom() })
    await joined('m2')

    await waitFor(() => expect(failures()).toEqual([{ type: 'localCopyFailed', generation: 3 }]))
    expect(calls('local_prepare')).toEqual([])
  })

  it('uma cópia que não mostra imagem em 30 s é largada', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    serve({ room: localRoom() })
    await joined('m2')
    await waitFor(() => expect(calls('local_prepare')).toHaveLength(1))

    await act(() => vi.advanceTimersByTimeAsync(30_000))

    await waitFor(() => expect(failures()).toEqual([{ type: 'localCopyFailed', generation: 3 }]))
    expect(calls('local_stop')).toEqual([{ key: 't-abc-2' }])
  })

  it('uma cópia que já mostra imagem segue depois dos 30 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    produced = 8000
    serve({ room: localRoom() })
    await joined('m2')
    await waitFor(() => expect(calls('local_regions').length).toBeGreaterThan(0))

    await act(() => vi.advanceTimersByTimeAsync(30_000))

    expect(failures()).toEqual([])
    expect(calls('local_stop')).toEqual([])
  })

  it('no navegador nada se abre', async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    resetDesktopForTests()
    serve({ room: localRoom() })
    await joined('m2')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(invoke).not.toHaveBeenCalledWith('torrent_open', expect.anything())
    expect(failures()).toEqual([])
  })
})
