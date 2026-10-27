import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { AccountPage } from './Account'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const me = { id: 128, nickname: 'iag', avatar: 'fox.bowtie', visibility: 'friends', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 41, hours: 63, friends: 2 } }
const lu = { id: 7, nickname: 'lu', avatar: 'frog.crown' }
const dudu = { id: 54, nickname: 'dudu', avatar: 'bear.cap' }
const caio = { id: 301, nickname: 'caio', avatar: '' }

type Call = { method: string; path: string; body: unknown }

/** The account API as the server answers it; `overrides` swaps single answers by "METHOD /path". */
function serve(signedIn: boolean, overrides: Record<string, () => Promise<Response>> = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = `${method} ${input}`
    if (overrides[key]) return overrides[key]()
    switch (key) {
      case 'GET /api/me': return signedIn ? respond(200, me) : respond(401, { error: 'not_signed_in' })
      case 'PATCH /api/me': return respond(200, { ...me, ...JSON.parse(String(init?.body)) })
      case 'GET /api/friends': return respond(200, { friends: [{ ...lu, presence: { inRoom: true, roomId: 'OMSRPLX0' } }, { ...dudu, presence: { inRoom: false } }] })
      case 'GET /api/friends/requests': return respond(200, { incoming: [caio], outgoing: [] })
      case 'GET /api/users/128/history': return respond(200, { history: [{ roomId: 'OMSRPLX0', title: 'Duna: Parte Dois', kind: 'torrent', startedAt: new Date().toISOString(), durationSec: 9000, with: [lu] }] })
      case 'GET /api/users/7': return respond(200, lu)
      case 'GET /api/users/7/history': return respond(403, { error: 'history_hidden' })
      default: return respond(200, {})
    }
  }))
  return calls
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<p>início</p>} />
        <Route path="/conta" element={<AccountPage />} />
        <Route path="/u/:id" element={<AccountPage />} />
        <Route path="/room/:id" element={<p>sala</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function mine(overrides?: Record<string, () => Promise<Response>>) {
  const calls = serve(true, overrides)
  await refreshMe()
  renderAt('/conta')
  await screen.findByText('Duna: Parte Dois')
  return calls
}

describe('AccountPage', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.language', 'pt-BR')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renames the account from its own page', async () => {
    const calls = await mine()
    expect(screen.getByText('#128')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mudar o apelido' }))
    const field = screen.getByRole('textbox', { name: 'Apelido' })
    fireEvent.change(field, { target: { value: '  iago ' } })
    fireEvent.submit(field)
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { nickname: 'iago' } }))
    expect(await screen.findByRole('heading', { name: 'iago' })).toBeInTheDocument()
  })

  it('saves the avatar built in the editor', async () => {
    const calls = await mine()
    fireEvent.click(screen.getByRole('button', { name: 'Mudar o avatar' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Gato' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { avatar: 'cat.bowtie' } }))
  })

  it('chooses who sees the history', async () => {
    const calls = await mine()
    fireEvent.click(screen.getByRole('radio', { name: 'Só eu' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { visibility: 'private' } }))
  })

  it('leads into the room a friend is in, and answers a request', async () => {
    const calls = await mine()
    expect(screen.getByRole('link', { name: /OMSRPLX0/ })).toHaveAttribute('href', '/room/OMSRPLX0')
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar caio' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/friends/requests/301/accept', body: undefined }))
  })

  it('asks a friend by number and says when no one has it', async () => {
    const calls = await mine({ 'POST /api/friends/requests': () => respond(404, { error: 'user_not_found' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    const field = await screen.findByRole('textbox', { name: 'Número da conta' })
    fireEvent.change(field, { target: { value: '#999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pedir amizade' }))
    expect(await screen.findByText('Ninguém com esse número.')).toBeInTheDocument()
    expect(calls).toContainEqual({ method: 'POST', path: '/api/friends/requests', body: { id: 999 } })
  })

  it('shows someone else without their hidden history or the controls of the owner', async () => {
    serve(true)
    await refreshMe()
    renderAt('/u/7')
    expect(await screen.findByText('Histórico fechado')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'lu' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mudar o avatar' })).toBeNull()
    expect(screen.queryByText('sessões')).toBeNull()
  })

  it('offers Discord to someone signed out, back to this page', async () => {
    serve(false)
    await refreshMe()
    renderAt('/conta')
    expect(await screen.findByRole('link', { name: 'Entrar com Discord' })).toHaveAttribute('href', '/api/auth/discord?next=%2Fconta')
  })

  it('signs out and goes home', async () => {
    const calls = await mine()
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }))
    expect(await screen.findByText('início')).toBeInTheDocument()
    expect(calls).toContainEqual({ method: 'POST', path: '/api/auth/logout', body: undefined })
  })
})
