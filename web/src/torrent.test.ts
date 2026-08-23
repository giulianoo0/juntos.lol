import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTorrent } from './torrent'
import { resetHelperAvailability } from './localHelper'

// The bridge path only runs when the local helper is absent, so every bridge
// call answers the helper's /health probe with a refusal first, then routes the
// bridge endpoints. Keeping the mock URL-aware also frees the assertions from
// the health call's position in the sequence.
function bridgeFetch(routes: Record<string, unknown[]>) {
  const cursors: Record<string, number> = {}
  const calls: Array<[string, RequestInit | undefined]> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init])
    if (url.includes('/health')) throw new Error('no helper')
    const queue = routes[url]
    if (!queue) throw new Error(`unexpected fetch ${url}`)
    const index = cursors[url] ?? 0
    cursors[url] = index + 1
    return queue[Math.min(index, queue.length - 1)]
  })
  return { fn, calls }
}

describe('server-backed torrent session', () => {
  beforeEach(() => resetHelperAvailability())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses bridge metadata and reads selected bytes over HTTP', async () => {
    const { fn, calls } = bridgeFetch({
      '/api/torrent-bridge/open': [{
        ok: true,
        json: async () => ({
          id: 'bridge-session',
          name: 'Show',
          magnet: 'magnet:?xt=urn:btih:abc',
          files: [
            { name: 'notes.txt', path: 'notes.txt', size: 3, type: 'text/plain' },
            { name: 'episode.mkv', path: 'show/episode.mkv', size: 6, type: 'video/x-matroska' },
          ],
          stats: { peers: 2, downloadSpeed: 100, downloaded: 0, progress: 0 },
        }),
      }],
      '/api/torrent-bridge/select': [{ ok: true, json: async () => ({ ok: true }) }],
      '/api/torrent-bridge/read': [{ ok: true, arrayBuffer: async () => new ArrayBuffer(2) }],
      '/api/torrent-bridge/close': [{ ok: true, json: async () => ({ ok: true }) }],
    })
    vi.stubGlobal('fetch', fn)

    const session = await openTorrent('magnet:?xt=urn:btih:abc')
    expect(session.name).toBe('Show')
    expect(session.files.map((file) => file.name)).toEqual(['episode.mkv'])

    await session.select('show/episode.mkv')
    await expect(session.files[0].read(0, 1)).resolves.toHaveProperty('byteLength', 2)
    const readCall = calls.find((call) => call[0] === '/api/torrent-bridge/read')
    expect(JSON.parse((readCall?.[1]?.body as string) ?? '{}')).toEqual({ id: 'bridge-session', start: 0, end: 1 })

    session.destroy()
    expect(calls.some((call) => call[0] === '/api/torrent-bridge/close')).toBe(true)
  })

  it('rejects truncated bridge reads', async () => {
    const { fn } = bridgeFetch({
      '/api/torrent-bridge/open': [{
        ok: true,
        json: async () => ({
          id: 'bridge-session', name: 'Show', magnet: 'magnet:?xt=urn:btih:abc',
          files: [{ name: 'episode.mkv', path: 'episode.mkv', size: 6, type: 'video/x-matroska' }],
          stats: { peers: 1, downloadSpeed: 0, downloaded: 0, progress: 0 },
        }),
      }],
      '/api/torrent-bridge/select': [{ ok: true, json: async () => ({ ok: true }) }],
      '/api/torrent-bridge/read': [{ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }],
      '/api/torrent-bridge/close': [{ ok: true, json: async () => ({ ok: true }) }],
    })
    vi.stubGlobal('fetch', fn)

    const session = await openTorrent('magnet:?xt=urn:btih:abc')
    await session.select('episode.mkv')
    await expect(session.files[0].read(0, 1)).rejects.toThrow('incomplete torrent read')
    session.destroy()
  })
})
