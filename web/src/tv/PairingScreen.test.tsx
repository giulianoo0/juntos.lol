import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingScreen } from './PairingScreen'

const account = { id: 9, nickname: 'Giuli' }
const device = { id: 'd1', name: 'Sala' }

let codes: string[]
let statuses: Array<() => Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/tv/pair' && init?.method === 'POST') {
    const code = codes.shift() ?? 'ZZZZZZZZ'
    return json({ pairId: `p-${code}`, code, expiresAt: new Date(Date.now() + 600_000).toISOString() })
  }
  if (url.startsWith('/api/tv/pair/')) return (statuses.shift() ?? (() => json({ status: 'pending' })))()
  return json({}, 404)
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  codes = ['ABCDEFGH', 'JKLMNPQR']
  statuses = []
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('PairingScreen', () => {
  it('mostra o código em dois blocos e o QR que leva ao vínculo no celular', async () => {
    render(<PairingScreen onLinked={vi.fn()} />)
    await settle()
    expect(screen.getByLabelText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'http://localhost/tv/vincular?c=ABCDEFGH' })).toBeInTheDocument()
  })

  it('pergunta a cada 2 s e entrega o token quando o celular vincula', async () => {
    const onLinked = vi.fn()
    statuses = [() => json({ status: 'pending' }), () => json({ status: 'linked', token: 'tok', account, device })]
    render(<PairingScreen onLinked={onLinked} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(onLinked).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(onLinked).toHaveBeenCalledWith({ token: 'tok', account, device })
  })

  it('código vencido vira um código novo', async () => {
    statuses = [() => json({ error: 'pair_not_found' }, 404)]
    render(<PairingScreen onLinked={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByLabelText('JKLM-NPQR')).toBeInTheDocument()
  })

  it('troca o código quando a hora dele passa, sem esperar o servidor dizer', async () => {
    render(<PairingScreen onLinked={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
    expect(screen.getByLabelText('JKLM-NPQR')).toBeInTheDocument()
  })

  it('servidor fora do ar: tenta de novo sozinho', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new TypeError('offline') })
    render(<PairingScreen onLinked={vi.fn()} />)
    await settle()
    expect(screen.queryByLabelText('ABCD-EFGH')).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByLabelText('ABCD-EFGH')).toBeInTheDocument()
  })
})
