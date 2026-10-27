import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { discordLoginUrl, fetchHistory, fetchMe, inviteFriend, InviteError, logout, useMe } from './account'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const ana = { id: 1, nickname: 'Ana', avatar: 'fox.bowtie', visibility: 'friends', createdAt: '2026-10-01T00:00:00Z', stats: { sessions: 2, hours: 1.5, friends: 3 } }

describe('account', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('volta para a página de onde saiu depois do login', () => {
    expect(discordLoginUrl('/r/ABCD1234?x=1')).toBe('/api/auth/discord?next=%2Fr%2FABCD1234%3Fx%3D1')
    expect(discordLoginUrl()).toBe('/api/auth/discord')
  })

  it('quem não entrou é null, não erro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respond(401, { error: 'not_signed_in' })))
    expect(await fetchMe()).toBeNull()
  })

  it('histórico fechado é null, não erro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respond(403, { error: 'history_hidden' })))
    expect(await fetchHistory(7)).toBeNull()
  })

  it('convite manda o POST e devolve a sala quando a DM está fechada', async () => {
    const fetchMock = vi.fn().mockReturnValueOnce(respond(204)).mockReturnValueOnce(respond(409, { error: 'dm_closed', roomId: 'OPEN1234' }))
    vi.stubGlobal('fetch', fetchMock)

    await inviteFriend(7)
    const refused = await inviteFriend(7).catch((error: unknown) => error)

    expect(fetchMock).toHaveBeenCalledWith('/api/friends/7/invite', { method: 'POST' })
    expect(refused).toBeInstanceOf(InviteError)
    expect(refused).toMatchObject({ message: 'dm_closed', roomId: 'OPEN1234' })
  })

  it('useMe traz a conta e esquece dela no logout', async () => {
    const fetchMock = vi.fn((input: string) => input === '/api/me' ? respond(200, ana) : respond(204))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useMe())
    await waitFor(() => expect(result.current.me).toEqual(ana))

    await act(async () => { await logout() })

    expect(result.current.me).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
  })
})
