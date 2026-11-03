import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { TvLinkPage } from './TvLink'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const me = { id: 128, nickname: 'iag', avatar: 'fox.bowtie', visibility: 'friends', discordVisibility: 'private', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 1, hours: 1, friends: 0 } }

type Call = { method: string; path: string; body: unknown }

async function openAt(path: string, { signedIn, link = () => respond(200, { device: { id: 'tv1', name: 'TV da sala' } }) }: { signedIn: boolean; link?: () => Promise<Response> }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (input === '/api/me') return signedIn ? respond(200, me) : respond(401, { error: 'not_signed_in' })
    if (input === '/api/tv/link') return link()
    return respond(200, { friendRequests: [], invites: [] })
  }))
  await refreshMe()
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/tv/vincular" element={<TvLinkPage />} /></Routes>
    </MemoryRouter>,
  )
  return calls
}

describe('TvLinkPage', () => {
  beforeEach(() => localStorage.setItem('ss.language', 'pt-BR'))
  afterEach(() => vi.unstubAllGlobals())

  it('sem conta, pede o Discord e volta para o mesmo link', async () => {
    const calls = await openAt('/tv/vincular?c=ABCDEFGH', { signedIn: false })
    const discord = screen.getAllByRole('link', { name: 'Entrar com Discord' }).at(-1)
    expect(discord).toHaveAttribute('href', `/api/auth/discord?next=${encodeURIComponent('/tv/vincular?c=ABCDEFGH')}`)
    expect(calls.some((call) => call.path === '/api/tv/link')).toBe(false)
  })

  it('com conta, vincula o código do link', async () => {
    const calls = await openAt('/tv/vincular?c=abcd-efgh', { signedIn: true })
    expect(await screen.findByRole('heading', { name: 'TV vinculada' })).toBeInTheDocument()
    expect(calls).toContainEqual({ method: 'POST', path: '/api/tv/link', body: { code: 'ABCDEFGH' } })
  })

  it('diz quando o código já não existe', async () => {
    await openAt('/tv/vincular?c=ABCDEFGH', { signedIn: true, link: () => respond(404, { error: 'code_not_found' }) })
    expect(await screen.findByRole('heading', { name: 'Código não encontrado' })).toBeInTheDocument()
  })
})
