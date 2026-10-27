import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from './NotificationBell'
import { POLL_MS, resetNotifications } from './notifications'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const caio = { id: 301, nickname: 'caio', avatar: '' }
const lu = { id: 7, nickname: 'lu', avatar: 'frog.crown' }
const waiting = { friendRequests: [caio], invites: [{ from: lu, roomId: 'OMSRPLX0', roomName: 'Sexta', at: '2026-10-27T20:00:00Z' }] }

function serve(body: unknown = waiting) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && input === '/api/notifications') return respond(200, body)
    if (input === '/api/friends/requests/301/accept') body = { ...waiting, friendRequests: [] }
    return respond(204)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderBell() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <NotificationBell />
      <Routes>
        <Route path="/" element={null} />
        <Route path="/room/:id" element={<p>sala</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NotificationBell', () => {
  beforeEach(() => {
    localStorage.setItem('ss.language', 'pt-BR')
    resetNotifications()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('is not there while nothing waits', async () => {
    const fetchMock = serve({ friendRequests: [], invites: [] })
    renderBell()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/notifications'))
    expect(screen.queryByRole('button', { name: /Notificações/ })).toBeNull()
  })

  it('counts what waits and answers a friend request', async () => {
    const fetchMock = serve()
    renderBell()
    const bell = await screen.findByRole('button', { name: 'Notificações (2)' })
    fireEvent.click(bell)
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByText('lu te chamou pra Sexta')).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Aceitar caio' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/friends/requests/301/accept', { method: 'POST' }))
    expect(within(panel).queryByText(/caio/)).toBeNull()
  })

  it('joins the room of an invite and clears it', async () => {
    const fetchMock = serve()
    renderBell()
    fireEvent.click(await screen.findByRole('button', { name: 'Notificações (2)' }))
    const panel = await screen.findByRole('dialog')

    fireEvent.click(within(panel).getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText('sala')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/invites/7', { method: 'DELETE' })
  })

  it('asks once a minute, and not while the tab is hidden', async () => {
    vi.useFakeTimers()
    const fetchMock = serve()
    renderBell()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3) })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    visibility.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
