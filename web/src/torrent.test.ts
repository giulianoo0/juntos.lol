import { afterEach, describe, expect, it, vi } from 'vitest'
import { HelperRequiredError, openTorrent } from './torrent'
import { resetHelperAvailability } from './localHelper'

// The helper is the only torrent path. The health probe is what decides
// whether it is there; the rest of the mock routes the helper's own endpoints.
function helperFetch(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url)
    const path = new URL(url).pathname
    const handler = routes[path]
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return typeof handler === 'function' ? handler(init) : handler
  })
  return { fn, calls }
}

const health = { ok: true, json: async () => ({ name: 'ss-bridge', version: '1.0.0' }) }

describe('openTorrent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetHelperAvailability()
  })

  it('refuses to open anything without the helper, rather than fetching the swarm elsewhere', async () => {
    const { fn, calls } = helperFetch({ '/health': () => { throw new Error('refused') } })
    vi.stubGlobal('fetch', fn)

    await expect(openTorrent('magnet:?xt=urn:btih:abc')).rejects.toBeInstanceOf(HelperRequiredError)
    // Only the probe went out: no server bridge, no in-browser client.
    expect(calls.every((url) => url.startsWith('http://127.0.0.1:32227/'))).toBe(true)
  })

  it('opens through the helper and reads selected bytes as ranged fetches', async () => {
    const { fn, calls } = helperFetch({
      '/health': health,
      '/add': {
        ok: true,
        text: async () => JSON.stringify({
          id: 'h1',
          name: 'Show',
          files: [
            { index: 0, name: 'notes.txt', path: 'notes.txt', size: 3 },
            { index: 1, name: 'episode.mkv', path: 'show/episode.mkv', size: 6 },
            { index: 2, name: 'episode.srt', path: 'show/episode.srt', size: 40 },
          ],
        }),
      },
      '/select': { ok: true, text: async () => '' },
      '/stream/h1/1': (init?: RequestInit) => {
        const range = String((init?.headers as Record<string, string>)?.Range)
        const [start, end] = range.replace('bytes=', '').split('-').map(Number)
        return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(end - start + 1) }
      },
      '/close': { ok: true, text: async () => '' },
    })
    vi.stubGlobal('fetch', fn)

    const session = await openTorrent('magnet:?xt=urn:btih:abc')
    expect(session.name).toBe('Show')
    expect(session.files.map((file) => file.name)).toEqual(['episode.mkv'])
    expect(session.subtitleFiles.map((file) => file.name)).toEqual(['episode.srt'])

    await session.select('show/episode.mkv')
    await expect(session.files[0].read(0, 1)).resolves.toHaveProperty('byteLength', 2)
    expect(calls.some((url) => url.endsWith('/stream/h1/1'))).toBe(true)
    session.destroy()
  })
})
