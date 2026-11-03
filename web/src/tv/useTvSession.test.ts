import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_KEY } from './api'
import { useTvSession } from './useTvSession'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: unknown[] = []
  url: string
  constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  drop() { this.readyState = 3; this.onclose?.() }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

const account = { id: 9, nickname: 'Giuli', avatar: 'fox.bowtie' }
const device = { id: 'd1', name: 'Sala' }
const latest = () => FakeWebSocket.instances.at(-1)!

let meStatus = 200
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/tv/me') return new Response(JSON.stringify({ account, device }), { status: meStatus })
  return new Response('{}', { status: 404 })
})

beforeEach(() => {
  meStatus = 200
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

async function waitingSession() {
  localStorage.setItem(TOKEN_KEY, 't1')
  const hook = renderHook(() => useTvSession())
  await waitFor(() => expect(hook.result.current.session.screen).toBe('waiting'))
  act(() => latest().open())
  return hook
}

describe('useTvSession', () => {
  it('com token guardado confere a conta, espera e abre o canal da TV com o token', async () => {
    const { result } = await waitingSession()
    expect(fetchMock).toHaveBeenCalledWith('/api/tv/me', expect.objectContaining({ headers: { Authorization: 'Bearer t1' } }))
    expect(result.current.session).toMatchObject({ screen: 'waiting', account })
    expect(latest().url).toBe('ws://localhost/ws/tv?token=t1')
  })

  it('token recusado pelo /tv/me é apagado e volta ao pareamento', async () => {
    meStatus = 401
    localStorage.setItem(TOKEN_KEY, 't1')
    const { result } = renderHook(() => useTvSession())
    await waitFor(() => expect(result.current.session.screen).toBe('pairing'))
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('o vínculo guarda o token', async () => {
    const { result } = renderHook(() => useTvSession())
    expect(result.current.session.screen).toBe('pairing')
    act(() => result.current.linked({ token: 't2', account, device }))
    expect(result.current.session.screen).toBe('waiting')
    expect(localStorage.getItem(TOKEN_KEY)).toBe('t2')
  })

  it('cast entra na sala e avisa o servidor; stop volta à espera e avisa também', async () => {
    const { result } = await waitingSession()
    act(() => latest().receive({ type: 'cast', roomId: 'R1', ticket: 'k1' }))
    expect(result.current.session).toMatchObject({ screen: 'room', roomId: 'R1', ticket: 'k1' })
    expect(latest().sent.at(-1)).toEqual({ type: 'state', roomId: 'R1' })

    act(() => latest().receive({ type: 'stop' }))
    expect(result.current.session.screen).toBe('waiting')
    expect(latest().sent.at(-1)).toEqual({ type: 'state', roomId: null })
  })

  it('a sala que fecha sozinha volta à espera e avisa o servidor', async () => {
    const { result } = await waitingSession()
    act(() => latest().receive({ type: 'cast', roomId: 'R1', ticket: 'k1' }))
    act(() => result.current.roomClosed('R1'))
    expect(result.current.session.screen).toBe('waiting')
    expect(latest().sent.at(-1)).toEqual({ type: 'state', roomId: null })
  })

  it('revogada pelo servidor, apaga o token, fecha o canal e volta ao pareamento', async () => {
    const { result } = await waitingSession()
    const socket = latest()
    act(() => socket.receive({ type: 'revoked' }))
    expect(result.current.session.screen).toBe('pairing')
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(socket.readyState).toBe(3)
  })

  it('o mix vem do servidor e as mudanças da TV vão para ele', async () => {
    const { result } = await waitingSession()
    act(() => latest().receive({ type: 'mix', mix: { media: 0.4, people: { m1: 0 } } }))
    expect(result.current.mix).toEqual({ media: 0.4, people: { m1: 0 } })

    act(() => result.current.changeMix({ media: 0.7, people: {} }))
    expect(result.current.mix).toEqual({ media: 0.7, people: {} })
    expect(latest().sent.at(-1)).toEqual({ type: 'mix', mix: { media: 0.7, people: {} } })
  })

  it('o canal que cai volta depois de um tempo e repete onde a TV está', async () => {
    const { result } = await waitingSession()
    vi.useFakeTimers()
    act(() => latest().receive({ type: 'cast', roomId: 'R1', ticket: 'k1' }))
    act(() => latest().drop())
    expect(FakeWebSocket.instances).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    act(() => latest().open())
    expect(latest().sent).toEqual([{ type: 'state', roomId: 'R1' }])
    expect(result.current.session.screen).toBe('room')
  })

  it('o canal recusado na porta confere o token e, revogado, volta ao pareamento', async () => {
    localStorage.setItem(TOKEN_KEY, 't1')
    const { result } = renderHook(() => useTvSession())
    await waitFor(() => expect(result.current.session.screen).toBe('waiting'))
    meStatus = 401
    act(() => latest().drop())
    await waitFor(() => expect(result.current.session.screen).toBe('pairing'))
  })
})
