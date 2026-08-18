import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTorrent } from './torrent'

describe('server-backed torrent session', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses bridge metadata and reads selected bytes over HTTP', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    const session = await openTorrent('magnet:?xt=urn:btih:abc')
    expect(session.name).toBe('Show')
    expect(session.files.map((file) => file.name)).toEqual(['episode.mkv'])

    await session.select('show/episode.mkv')
    await expect(session.files[0].read(0, 1)).resolves.toHaveProperty('byteLength', 2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/torrent-bridge/select')
    expect(fetchMock.mock.calls[2][0]).toBe('/api/torrent-bridge/read')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ id: 'bridge-session', start: 0, end: 1 })

    session.destroy()
    expect(fetchMock.mock.calls[3][0]).toBe('/api/torrent-bridge/close')
  })

  it('rejects truncated bridge reads', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'bridge-session', name: 'Show', magnet: 'magnet:?xt=urn:btih:abc',
          files: [{ name: 'episode.mkv', path: 'episode.mkv', size: 6, type: 'video/x-matroska' }],
          stats: { peers: 1, downloadSpeed: 0, downloaded: 0, progress: 0 },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }))

    const session = await openTorrent('magnet:?xt=urn:btih:abc')
    await session.select('episode.mkv')
    await expect(session.files[0].read(0, 1)).rejects.toThrow('incomplete torrent read')
    session.destroy()
  })
})
