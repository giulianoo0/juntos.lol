import { afterEach, describe, expect, it, vi } from 'vitest'
import { importExtensionSubtitles } from './subtitles'

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nOlá\n'
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'

afterEach(() => { vi.unstubAllGlobals() })

describe('legendas mandadas pela extensão', () => {
  it('baixa, converte e importa cada uma para a sala, e pula a que não dá', async () => {
    const posted: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({ subtitleTracks: [{ index: 1000 }] })
    }))
    const get = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.endsWith('/pt')) return new Response(SRT)
      if (u.endsWith('/en')) return new Response(VTT)
      return new Response('nope', { status: 404 })
    })

    const imported = await importExtensionSubtitles('sala', 'm1', 'cap', 3, [
      { url: 'https://subs.example/pt', lang: 'por', label: 'Português' },
      { url: 'https://subs.example/sumiu', lang: 'spa' },
      { url: 'https://subs.example/en', lang: 'eng' },
    ], get)

    expect(imported).toBe(2)
    expect(posted.map((body) => [body.language, body.title, body.mediaGeneration])).toEqual([['por', 'Português', 3], ['eng', 'eng', 3]])
    expect(String(posted[0].vtt)).toContain('Olá')
    expect(String(posted[1].vtt)).toContain('Hello')
  })
})
