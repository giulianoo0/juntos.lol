import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
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

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function renderHome(createRoom = vi.fn().mockResolvedValue({ roomID: 'K7Q2M9XA' }), at = '/') {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/" element={<><Home createRoom={createRoom} /><Where /></>} />
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

  it('signing in from the create panel comes back to create the room, with its name', async () => {
    renderHome()
    const panel = await openCreate()
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Nome da sala' }), { target: { value: 'Sexta & cia' } })
    const next = new URL(within(panel).getByRole('link', { name: 'Entrar com Discord' }).getAttribute('href')!, 'https://juntos.lol').searchParams.get('next')!
    const back = new URL(next, 'https://juntos.lol')
    expect(back.pathname).toBe('/')
    expect(back.searchParams.get('create')).toBe('1')
    expect(back.searchParams.get('name')).toBe('Sexta & cia')
  })

  it('never puts the password in the sign-in link, only that there was one', async () => {
    renderHome()
    const panel = await openCreate()
    fireEvent.click(within(panel).getByRole('button', { name: 'Senha' }))
    fireEvent.change(within(panel).getByLabelText('Senha', { selector: 'input' }), { target: { value: 'pipoca' } })
    const href = within(panel).getByRole('link', { name: 'Entrar com Discord' }).getAttribute('href')!
    expect(decodeURIComponent(decodeURIComponent(href))).not.toContain('pipoca')
    const back = new URL(new URL(href, 'https://juntos.lol').searchParams.get('next')!, 'https://juntos.lol')
    expect(back.searchParams.get('locked')).toBe('1')
  })

  it('back from signing in, creates the room by itself and drops the ask from the address', async () => {
    await signedIn(giu)
    let finish: (value: { roomID: string }) => void = () => {}
    const createRoom = renderHome(vi.fn(() => new Promise<{ roomID: string }>((resolve) => { finish = resolve })), '/?create=1&name=Sexta')
    const panel = await screen.findByRole('dialog')
    const go = within(panel).getByRole('button', { name: 'Criar' })
    expect(go).toHaveAttribute('aria-busy', 'true')
    expect(go).toBeDisabled()
    expect(createRoom).toHaveBeenCalledTimes(1)
    expect(createRoom).toHaveBeenCalledWith({ name: 'Sexta', password: '' })
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
    await act(async () => { finish({ roomID: 'K7Q2M9XA' }) })
    expect(await screen.findByText('sala K7Q2M9XA')).toBeInTheDocument()
  })

  it('back from signing in with a locked room, asks the password again instead of creating', async () => {
    await signedIn(giu)
    const createRoom = renderHome(undefined, '/?create=1&name=Sexta&locked=1')
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByRole('textbox', { name: 'Nome da sala' })).toHaveValue('Sexta')
    expect(within(panel).getByLabelText('Senha', { selector: 'input' })).toHaveValue('')
    expect(createRoom).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  it('back without an account (the sign-in failed), only opens the panel', async () => {
    const createRoom = renderHome(undefined, '/?create=1&name=Sexta')
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByRole('textbox', { name: 'Nome da sala' })).toHaveValue('Sexta')
    expect(createRoom).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  it('shows the create button working while the room is made, under the same words', async () => {
    renderHome(vi.fn(() => new Promise<{ roomID: string }>(() => {})))
    const panel = await openCreate()
    fireEvent.click(within(panel).getByRole('button', { name: 'Continuar sem conta' }))
    const go = within(panel).getByRole('button', { name: 'Continuar sem conta' })
    expect(go).toHaveAttribute('aria-busy', 'true')
    expect(go).toBeDisabled()
  })

  it('with an account, the corner leads to it and creating asks nothing', async () => {
    await signedIn(giu)
    const createRoom = renderHome()
    expect(screen.getByRole('link', { name: 'giu #128' })).toHaveAttribute('href', '/c/128')
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
