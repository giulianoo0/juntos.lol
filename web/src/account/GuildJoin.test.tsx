import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshMe } from '../account'
import { GuildJoin } from './GuildJoin'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const ana = { id: 1, nickname: 'Ana', avatar: '', visibility: 'private', discordVisibility: 'private', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 0, hours: 0, friends: 0 } }

async function visit(at: string, me: (typeof ana & { guildPending: boolean }) | null) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/me') return respond(me ? 200 : 401, me ?? { error: 'not_signed_in' })
    if (input === '/api/me/discord-guild' && init?.method === 'POST') return respond(200, { authorize: true })
    return respond(404)
  })
  vi.stubGlobal('fetch', fetchMock)
  await refreshMe()
  const leave = vi.fn()
  render(<MemoryRouter initialEntries={[at]}><GuildJoin leave={leave} /></MemoryRouter>)
  const asked = () => fetchMock.mock.calls.some(([input]) => input === '/api/me/discord-guild')
  return { leave, asked }
}

describe('GuildJoin', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leva a conta pendente fora de sala ao Discord uma vez', async () => {
    const first = await visit('/conta?aba=amigos', { ...ana, guildPending: true })
    await waitFor(() => expect(first.leave).toHaveBeenCalledWith('/api/auth/discord?next=%2Fconta%3Faba%3Damigos'))
    expect(first.leave).toHaveBeenCalledTimes(1)

    const second = await visit('/conta', { ...ana, guildPending: false })
    expect(second.asked()).toBe(false)
    expect(second.leave).not.toHaveBeenCalled()
  })

  it('não tira ninguém de dentro de uma sala', async () => {
    const { leave, asked } = await visit('/room/K7Q2M9XA', { ...ana, guildPending: true })
    expect(asked()).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })

  it('não leva anônimo a lugar nenhum', async () => {
    const { leave, asked } = await visit('/', null)
    expect(asked()).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })
})
