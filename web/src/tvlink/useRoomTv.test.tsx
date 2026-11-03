import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mix, TvDevice } from './api'
import { useRoomTv } from './useRoomTv'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

type Call = { method: string; path: string; body: unknown }

function serve(devices: TvDevice[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'GET' && input === '/api/tv/devices') return respond(200, { devices })
    return respond(204)
  }))
  return {
    calls,
    polls: () => calls.filter((call) => call.method === 'GET' && call.path === '/api/tv/devices').length,
  }
}

const sala = (extra: Partial<TvDevice> = {}): TvDevice => ({ id: 'tv1', name: 'TV da sala', online: true, mix: { media: 1, people: {} }, ...extra })

const mount = () => renderHook(() => useRoomTv({ roomId: 'ROOM1', signedIn: true, loginUrl: '/api/auth/discord' }))

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('useRoomTv', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pergunta as TVs ao entrar e só repete a cada 2 s com o menu aberto', async () => {
    const server = serve([sala()])
    const { result } = mount()
    await wait(6_000)
    expect(server.polls()).toBe(1)
    expect(result.current.devices).toEqual([{ id: 'tv1', name: 'TV da sala', online: true, here: false, mix: { media: 1, people: {} } }])

    act(() => result.current.watch(true))
    await wait(4_000)
    expect(server.polls()).toBe(4)

    act(() => result.current.watch(false))
    await wait(6_000)
    expect(server.polls()).toBe(4)
  })

  it('segue perguntando enquanto uma TV toca esta sala', async () => {
    const server = serve([sala({ roomId: 'ROOM1' })])
    mount()
    await wait(0)
    await wait(2_000)
    await wait(2_000)
    expect(server.polls()).toBe(3)
  })

  it('grava o mix uma vez só, depois que a mão para', async () => {
    const server = serve([sala({ roomId: 'ROOM1' })])
    const { result } = mount()
    await wait(0)
    const mixes: Mix[] = [0.2, 0.4, 0.6].map((media) => ({ media, people: { giu: 0 } }))
    for (const mix of mixes) {
      act(() => result.current.setMix('tv1', mix))
      await wait(50)
    }
    expect(result.current.devices?.[0]?.mix).toEqual(mixes[2])
    await wait(500)
    const puts = server.calls.filter((call) => call.method === 'PUT')
    expect(puts).toEqual([{ method: 'PUT', path: '/api/tv/devices/tv1/mix', body: mixes[2] }])
  })

  it('o poll não desfaz o mix que ainda não foi gravado', async () => {
    serve([sala({ roomId: 'ROOM1' })])
    const { result } = mount()
    await wait(0)
    await wait(1_900)
    act(() => result.current.setMix('tv1', { media: 0.3, people: {} }))
    await wait(150)
    expect(result.current.devices?.[0]?.mix.media).toBe(0.3)
  })

  it('espelha na TV com o id da sala', async () => {
    const server = serve([sala()])
    const { result } = mount()
    await wait(0)
    await act(() => result.current.cast('tv1'))
    expect(server.calls).toContainEqual({ method: 'POST', path: '/api/tv/devices/tv1/cast', body: { roomId: 'ROOM1' } })
  })
})
