import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { ToastProvider } from '../ui/Toast'
import { AccountPage, LegacyProfile, readableTitle } from './Account'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const me = { id: 128, nickname: 'iag', avatar: 'fox.bowtie', visibility: 'friends', discordVisibility: 'private', discord: { username: 'iag.x', globalName: 'Iag' }, createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 41, hours: 63, friends: 2 } }
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
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<p>início</p>} />
          <Route path="/conta" element={<AccountPage />} />
          <Route path="/c/:id" element={<AccountPage />} />
          <Route path="/u/:id" element={<LegacyProfile />} />
          <Route path="/room/:id" element={<p>sala</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
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
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Quem vê o histórico' })).getByRole('radio', { name: 'Só eu' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { visibility: 'private' } }))
  })

  it('shows its own Discord name and chooses who sees it', async () => {
    const calls = await mine()
    expect(screen.getByText('@iag.x')).toBeInTheDocument()
    const discord = screen.getByRole('radiogroup', { name: 'Quem vê o Discord' })
    expect(within(discord).getByRole('radio', { name: 'Só eu' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(discord).getByRole('radio', { name: 'Público' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { discordVisibility: 'public' } }))
  })

  it('sends /conta to its own /c/ page', async () => {
    await mine()
    expect(screen.getByRole('heading', { name: 'iag' })).toBeInTheDocument()
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

  it('invites an offline friend by DM', async () => {
    const calls = await mine({ 'POST /api/friends/54/invite': () => respond(204) })
    fireEvent.click(screen.getByRole('button', { name: 'Convidar dudu' }))
    expect(await screen.findByText('Convite enviado')).toBeInTheDocument()
    expect(calls).toContainEqual({ method: 'POST', path: '/api/friends/54/invite', body: undefined })
  })

  it('invites a friend who is in another room, but not one already in mine', async () => {
    await mine({
      'GET /api/friends': () => respond(200, { friends: [
        { ...lu, presence: { inRoom: true, roomId: 'OMSRPLX0' } },
        { ...dudu, presence: { inRoom: true, withMe: true } },
      ] }),
    })
    expect(screen.getByRole('button', { name: 'Convidar lu' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Convidar dudu' })).toBeNull()
  })

  it('holds the invite button busy while the DM goes', async () => {
    await mine({ 'POST /api/friends/54/invite': () => new Promise<Response>(() => undefined) })
    const button = screen.getByRole('button', { name: 'Convidar dudu' })
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'))
    expect(button).toBeDisabled()
  })

  it('copies the room link when the friend takes no DMs from the bot', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await mine({ 'POST /api/friends/54/invite': () => respond(409, { error: 'dm_closed', roomId: 'LOCK1234' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Convidar dudu' }))
    expect(await screen.findByText('dudu não recebe DM do bot no Discord. Link da sala copiado.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/room/LOCK1234`)
  })

  it('asks to join a room before inviting', async () => {
    await mine({ 'POST /api/friends/54/invite': () => respond(409, { error: 'not_in_room' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Convidar dudu' }))
    expect(await screen.findByText('Entre numa sala primeiro')).toBeInTheDocument()
  })

  it('holds the place of friends and history with skeletons while they load', async () => {
    const pending = () => new Promise<Response>(() => undefined)
    serve(true, { 'GET /api/friends': pending, 'GET /api/friends/requests': pending, 'GET /api/users/128/history': pending })
    await refreshMe()
    renderAt('/conta')
    const friends = await screen.findByRole('region', { name: 'Amigos' })
    expect(friends).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('region', { name: 'Histórico' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })

  it('holds the place of a profile with a skeleton while it loads', async () => {
    serve(true, { 'GET /api/users/7': () => new Promise<Response>(() => undefined) })
    await refreshMe()
    renderAt('/u/7')
    const main = await screen.findByRole('main')
    await waitFor(() => expect(main.firstElementChild).toHaveAttribute('aria-busy', 'true'))
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })

  it('shows someone else without their hidden history or the controls of the owner', async () => {
    serve(true)
    await refreshMe()
    renderAt('/u/7')
    expect(await screen.findByText('Histórico fechado')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'lu' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mudar o avatar' })).toBeNull()
    expect(screen.queryByText('sessões')).toBeNull()
    expect(screen.queryByText(/^@/)).toBeNull()
  })

  it('tells a private account apart from a number no one has, and asks to be friends', async () => {
    const calls = serve(true, {
      'GET /api/users/5': () => respond(403, { error: 'account_private' }),
      'GET /api/users/5/history': () => respond(403, { error: 'account_private' }),
      'POST /api/friends/requests': () => respond(200, { state: 'requested' }),
    })
    await refreshMe()
    renderAt('/c/5')
    expect(await screen.findByRole('heading', { name: 'Conta privada' })).toBeInTheDocument()
    expect(screen.queryByText('Ninguém com esse número')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pedir amizade' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/friends/requests', body: { id: 5 } }))
    expect(await screen.findByText('Pedido enviado')).toBeInTheDocument()
  })

  it('offers Discord on a private account to someone signed out', async () => {
    serve(false, { 'GET /api/users/5': () => respond(403, { error: 'account_private' }) })
    await refreshMe()
    renderAt('/c/5')
    expect(await screen.findByRole('heading', { name: 'Conta privada' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Entrar com Discord' })).toHaveAttribute('href', '/api/auth/discord?next=%2Fc%2F5')
  })

  it('still says no one has a number that is free', async () => {
    serve(true, { 'GET /api/users/42': () => respond(404, { error: 'user_not_found' }) })
    await refreshMe()
    renderAt('/c/42')
    expect(await screen.findByRole('heading', { name: 'Ninguém com esse número' })).toBeInTheDocument()
  })

  it('shows the Discord name of someone who made it public', async () => {
    serve(true, { 'GET /api/users/7': () => respond(200, { ...lu, discord: { username: 'lu.discord' } }) })
    await refreshMe()
    renderAt('/c/7')
    expect(await screen.findByText('@lu.discord')).toBeInTheDocument()
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

describe('readableTitle', () => {
  it('turns a release file name into the title', () => {
    expect(readableTitle('Helluva.Boss.S03E05.1080p.WEB-DL.MeGusta.mkv')).toBe('Helluva Boss S03E05')
    expect(readableTitle('Helluva.Boss.S03E05.The.Audition.1080p.AMZN.WEB-DL.ENG.ITA.DDP5.1.H264-x.mkv')).toBe('Helluva Boss S03E05 The Audition')
  })

  it('leaves a title that is already a title alone', () => {
    expect(readableTitle('Meu filme favorito')).toBe('Meu filme favorito')
    expect(readableTitle('Lofi Girl - beats to relax')).toBe('Lofi Girl - beats to relax')
  })
})
