import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageFetch } from './spawn'

function hopAnswer(body: string, init: { status?: number; finalUrl?: string | null } = {}) {
  const headers = new Headers()
  if (init.finalUrl !== null) headers.set('X-Final-Url', init.finalUrl ?? 'https://a.com/x')
  return new Response(body, { status: init.status ?? 200, headers })
}

describe('pageFetch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the server to perform the request, never the addon directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(hopAnswer('{"streams":[]}'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await pageFetch(new URL('https://a.com/stream/movie/tt1.json?x=1'), new AbortController().signal)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/plugins/fetch?url=' + encodeURIComponent('https://a.com/stream/movie/tt1.json?x=1'))
    // The session cookie is the hop's budget; it has to ride along.
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(result).toEqual({ ok: true, status: 200, text: '{"streams":[]}', finalUrl: 'https://a.com/x' })
  })

  it('reports the addon status and where the answer came from', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hopAnswer('nope', { status: 404, finalUrl: 'https://b.com/moved' })))

    const result = await pageFetch(new URL('https://a.com/x'), new AbortController().signal)

    expect(result).toMatchObject({ ok: false, status: 404, text: 'nope', finalUrl: 'https://b.com/moved' })
  })

  it('treats an answer with no landing url as the hop failing, not the addon', async () => {
    // A 502 from the hop and a 502 from the addon are different problems:
    // the landing url is what tells them apart, and a missing one must not
    // reach the plugin as if the addon had answered.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hopAnswer('{"error":"upstream","reason":"dial"}', { status: 502, finalUrl: null })))

    await expect(pageFetch(new URL('https://a.com/x'), new AbortController().signal))
      .rejects.toThrow(/hop 502/)
  })
})
