import { describe, expect, it, vi } from 'vitest'
import { probeSize } from './probeSize'

const response = (status: number, headers: Record<string, string>) => new Response(null, { status, headers })

describe('tamanho de uma url', () => {
  it('lê Content-Length e o tipo do HEAD', async () => {
    const fetch = vi.fn(async () => response(200, { 'Content-Length': '1234', 'Content-Type': 'video/mp4' }))

    expect(await probeSize('https://files.example.com/a.mp4', { fetch })).toEqual({ size: 1234, type: 'video/mp4' })
    expect(fetch).toHaveBeenCalledWith('https://files.example.com/a.mp4', expect.objectContaining({ method: 'HEAD' }))
  })

  it.each([
    ['o HEAD lança', () => { throw new TypeError('Failed to fetch') }],
    ['o HEAD é recusado', () => response(405, {})],
    ['o HEAD não diz o tamanho', () => response(200, {})],
  ])('cai para Range 0-0 quando %s', async (_, head) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD'
      ? head()
      : response(206, { 'Content-Range': 'bytes 0-0/987654', 'Content-Type': 'video/x-matroska' }))

    expect(await probeSize('https://files.example.com/a.mkv', { fetch })).toEqual({ size: 987654, type: 'video/x-matroska' })
    expect(fetch).toHaveBeenLastCalledWith('https://files.example.com/a.mkv', expect.objectContaining({ headers: { Range: 'bytes=0-0' } }))
  })

  it('aceita um 200 sem Range quando ele diz o tamanho', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD'
      ? response(405, {})
      : response(200, { 'Content-Length': '42' }))

    expect(await probeSize('https://files.example.com/a.ts', { fetch })).toEqual({ size: 42, type: null })
  })

  it('falha quando ninguém diz o tamanho', async () => {
    const fetch = vi.fn(async () => response(200, {}))

    await expect(probeSize('https://files.example.com/a.ts', { fetch })).rejects.toThrow(/size/)
  })
})
