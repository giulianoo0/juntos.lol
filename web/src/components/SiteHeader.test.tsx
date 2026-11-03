import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { SiteHeader } from './SiteHeader'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const me = { id: 128, nickname: 'iag', avatar: 'fox.bowtie', visibility: 'friends', discordVisibility: 'private', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 1, hours: 1, friends: 0 } }

function serve() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    calls.push(key)
    if (key === 'GET /api/me') return respond(200, me)
    if (key === 'GET /api/notifications') return respond(200, { friendRequests: [], invites: [] })
    return respond(204)
  }))
  return calls
}

async function renderHeader() {
  const calls = serve()
  await refreshMe()
  render(
    <MemoryRouter initialEntries={['/']}>
      <SiteHeader />
      <Routes>
        <Route path="/" element={<p>início</p>} />
        <Route path="/c/:id" element={<p>perfil</p>} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'iag #128' }))
  return calls
}

describe('SiteHeader', () => {
  beforeEach(() => localStorage.setItem('ss.language', 'pt-BR'))
  afterEach(() => vi.unstubAllGlobals())

  it('leva ao perfil pelo menu do avatar', async () => {
    await renderHeader()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ver perfil' }))
    expect(await screen.findByText('perfil')).toBeInTheDocument()
  })

  it('abre o diálogo de vincular TV pelo menu do avatar', async () => {
    await renderHeader()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Vincular TV' }))
    expect(await screen.findByRole('textbox', { name: 'Código da TV' })).toBeInTheDocument()
  })

  it('sai da conta pelo menu do avatar', async () => {
    const calls = await renderHeader()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sair' }))
    await waitFor(() => expect(calls).toContain('POST /api/auth/logout'))
    expect(await screen.findByRole('link', { name: 'Entrar com Discord' })).toBeInTheDocument()
  })
})
