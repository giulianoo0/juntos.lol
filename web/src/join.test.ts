import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELOAD_WINDOW_MS, claimOwnerFromHash, fetchRoomPreview, joinTicketFor, rememberForReload, requestJoinTicket, setRoomAccess, takeReload } from './join'
import { ownerTokenFor } from './upload'

const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

describe('join', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the preview of a room, and null for one that is gone', async () => {
    const fetchMock = vi.fn().mockReturnValueOnce(respond(200, { joinMode: 'password', memberCount: 3, nicknames: ['ana'] })).mockReturnValueOnce(respond(404, { error: 'room_not_found' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchRoomPreview('ABC')).toEqual({ joinMode: 'password', memberCount: 3, nicknames: ['ana'] })
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/ABC/preview')
    expect(await fetchRoomPreview('ABC')).toBeNull()
  })

  it('trades the password for a ticket and keeps it for the hello', async () => {
    const fetchMock = vi.fn().mockReturnValue(respond(200, { ticket: 't-1' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await requestJoinTicket('ABC', 'pipoca')).toBe('t-1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: 'pipoca' })
    expect(joinTicketFor('ABC')).toBe('t-1')
    expect(joinTicketFor('XYZ')).toBe('')
  })

  it('names why the password was refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(respond(401, { error: 'bad_password' })).mockReturnValueOnce(respond(429, { error: 'too_many_attempts' })))
    await expect(requestJoinTicket('ABC', 'milho')).rejects.toThrow('bad_password')
    await expect(requestJoinTicket('ABC', 'milho')).rejects.toThrow('too_many_attempts')
  })

  it('sends the host\'s switch with the member\'s proof', async () => {
    const fetchMock = vi.fn().mockReturnValue(respond(200, { joinMode: 'approval' }))
    vi.stubGlobal('fetch', fetchMock)
    await setRoomAccess('ABC', 'm1', 'cap', 'approval')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/rooms/ABC/access')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ memberId: 'm1', capability: 'cap', joinMode: 'approval' })
  })

  it('walks a reload back in under the same name, once and only within the window', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    rememberForReload('r1', 'giuli')
    now.mockReturnValue(1_000_000 + RELOAD_WINDOW_MS - 1)
    expect(takeReload('r1')).toBe('giuli')
    expect(takeReload('r1')).toBeNull()

    rememberForReload('r1', 'giuli')
    now.mockReturnValue(1_000_000 + 2 * RELOAD_WINDOW_MS)
    expect(takeReload('r1')).toBeNull()
    expect(takeReload('r2')).toBeNull()
    now.mockRestore()
  })

  it('takes the host token out of the link it came in and remembers it', () => {
    const replace = vi.spyOn(history, 'replaceState')
    expect(claimOwnerFromHash('ABC', '#owner=secret-token')).toBe(true)
    expect(ownerTokenFor('ABC')).toBe('secret-token')
    expect(replace).toHaveBeenCalled()
    expect(claimOwnerFromHash('XYZ', '')).toBe(false)
    expect(ownerTokenFor('XYZ')).toBe('')
  })
})
