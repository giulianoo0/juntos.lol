import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_KEY } from './api'
import { TvApp } from './TvApp'

// The room itself is the browser's room (useSync, Player, relay); here only what the TV does around it.
vi.mock('./TvRoom', () => ({
  TvRoom: ({ roomId }: { roomId: string }) => <p>sala {roomId}</p>,
}))

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
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

const account = { id: 9, nickname: 'Giuli', avatar: 'fox.bowtie' }
const device = { id: 'd1', name: 'Sala' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let pairAnswers: Array<() => Response>
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/tv/pair' && init?.method === 'POST') return json({ pairId: 'p1', code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 600_000).toISOString() })
  if (url === '/api/tv/pair/p1') return (pairAnswers.shift() ?? (() => json({ status: 'pending' })))()
  if (url === '/api/tv/me') return json({ account, device })
  return json({}, 404)
})
const socket = () => FakeWebSocket.instances.at(-1)!
const back = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'XF86Back', keyCode: 10009, bubbles: true, cancelable: true })) })

beforeEach(() => {
  localStorage.clear()
  pairAnswers = []
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

async function inWaiting() {
  localStorage.setItem(TOKEN_KEY, 't1')
  render(<TvApp />)
  await screen.findByText('Giuli')
  act(() => socket().open())
}

describe('TvApp', () => {
  it('vincula pelo código, espera com o rosto da conta e entra na sala do cast', async () => {
    vi.useFakeTimers()
    pairAnswers = [() => json({ status: 'linked', token: 't9', account, device })]
    render(<TvApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByLabelText('ABCD-EFGH')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByText('Giuli')).toBeInTheDocument()
    expect(localStorage.getItem(TOKEN_KEY)).toBe('t9')

    act(() => socket().open())
    act(() => socket().receive({ type: 'cast', roomId: 'R1', ticket: 'k1' }))
    expect(screen.getByText('sala R1')).toBeInTheDocument()
    act(() => socket().receive({ type: 'stop' }))
    expect(screen.getByText('Giuli')).toBeInTheDocument()
  })

  it('Voltar na espera pergunta antes de sair do app', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    await inWaiting()
    back()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()

    back()
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }))
    expect(close).toHaveBeenCalled()
  })

  it('Voltar na sala pergunta se para de espelhar, e parar volta à espera avisando o servidor', async () => {
    await inWaiting()
    act(() => socket().receive({ type: 'cast', roomId: 'R1', ticket: 'k1' }))
    back()
    expect(screen.getByRole('alertdialog', { name: 'Parar de espelhar?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Parar de espelhar' }))
    expect(screen.getByText('Giuli')).toBeInTheDocument()
    expect(socket().sent.at(-1)).toEqual({ type: 'state', roomId: null })
  })

  it('o segundo Voltar com a pergunta aberta só fecha a pergunta', async () => {
    await inWaiting()
    back()
    back()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
