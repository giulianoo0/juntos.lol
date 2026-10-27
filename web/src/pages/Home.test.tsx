import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { Home } from './Home'

function RoomStub() {
  return <p>sala {useParams().id}</p>
}

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const giu = { id: 128, nickname: 'giu', avatar: 'fox.bowtie', visibility: 'friends', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 2, hours: 1, friends: 3 } }

async function signedIn(me: typeof giu | null) {
  vi.stubGlobal('fetch', vi.fn((input: string) => input === '/api/me' ? respond(me ? 200 : 401, me ?? { error: 'not_signed_in' }) : respond(404)))
  await refreshMe()
}

function renderHome(createRoom = vi.fn().mockResolvedValue({ roomID: 'K7Q2M9XA' })) {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Home createRoom={createRoom} />} />
        <Route path="/room/:id" element={<RoomStub />} />
      </Routes>
    </MemoryRouter>,
  )
  return createRoom
}

async function openCreate() {
  fireEvent.click(screen.getByRole('button', { name: 'Criar sala' }))
  return await screen.findByRole('dialog')
}

describe('Home', () => {
  beforeEach(async () => {
    localStorage.clear()
    localStorage.setItem('ss.language', 'pt-BR')
    await signedIn(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates a room with its name and goes into it', async () => {
    const createRoom = renderHome()
    const panel = await openCreate()
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Nome da sala' }), { target: { value: '  Sessão de sexta ' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Continuar sem conta' }))
    expect(createRoom).toHaveBeenCalledWith({ name: 'Sessão de sexta', password: '' })
    expect(await screen.findByText('sala K7Q2M9XA')).toBeInTheDocument()
  })

  it('asks for a password only after the lock is pressed', async () => {
    const createRoom = renderHome()
    const panel = await openCreate()
    expect(within(panel).queryByLabelText('Senha', { selector: 'input' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: 'Senha' }))
    expect(within(panel).getByRole('button', { name: 'Senha' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(within(panel).getByLabelText('Senha', { selector: 'input' }), { target: { value: 'pipoca' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Continuar sem conta' }))
    expect(createRoom).toHaveBeenCalledWith({ name: '', password: 'pipoca' })
  })

  it('says when the room could not be created', async () => {
    renderHome(vi.fn().mockRejectedValue(new Error('nope')))
    const panel = await openCreate()
    fireEvent.click(within(panel).getByRole('button', { name: 'Continuar sem conta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para criar a sala')
  })

  it('suggests signing in with Discord before creating, coming back home', async () => {
    renderHome()
    const panel = await openCreate()
    expect(within(panel).getByRole('link', { name: 'Entrar com Discord' })).toHaveAttribute('href', '/api/auth/discord?next=%2F')
  })

  it('with an account, the corner leads to it and creating asks nothing', async () => {
    await signedIn(giu)
    const createRoom = renderHome()
    expect(screen.getByRole('link', { name: 'giu #128' })).toHaveAttribute('href', '/conta')
    const panel = await openCreate()
    expect(within(panel).queryByRole('link', { name: 'Entrar com Discord' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: 'Criar' }))
    expect(createRoom).toHaveBeenCalledWith({ name: '', password: '' })
  })

  it('enters a room by its code, or by a pasted link', async () => {
    renderHome()
    const code = screen.getByRole('textbox', { name: 'Código da sala' })
    const enter = screen.getByRole('button', { name: 'Entrar' })
    expect(enter).toBeDisabled()
    fireEvent.change(code, { target: { value: 'https://juntos.lol/room/k7q2m9xa' } })
    fireEvent.click(enter)
    expect(await screen.findByText('sala K7Q2M9XA')).toBeInTheDocument()
  })

  it('keeps the title the same for screen readers while the word turns', () => {
    vi.useFakeTimers()
    renderHome()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.getByRole('heading', { level: 1, name: 'Bora assistir junto?' })).toBeInTheDocument()
  })

  it('offers the Discord app in a new tab', () => {
    renderHome()
    const link = screen.getByRole('link', { name: 'Adicionar ao Discord' })
    expect(link).toHaveAttribute('href', 'https://discord.com/oauth2/authorize?client_id=1564358804206911529')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
