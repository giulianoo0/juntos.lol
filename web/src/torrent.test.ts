import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoWorkersError, TorrentRejectedError, WorkersBusyError, openTorrent } from './torrent'

// The fleet is the only torrent path: the server registers the hash, the
// worker lists it, and the bytes come straight from the worker's origin.
const MAGNET = 'magnet:?xt=urn:btih:' + 'ab'.repeat(20) + '&dn=Show&tr=udp%3A%2F%2Ft.example%3A1337'

type Handler = (init?: RequestInit) => Response | Promise<Response>
function fleetFetch(routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url.startsWith('/') ? url : new URL(url).pathname}`
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected fetch ${key}`)
    return handler(init)
  })
  return { fn, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('openTorrent', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('names a fleet that is missing, and one that is full', async () => {
    const { fn } = fleetFetch({ 'POST /api/torrents': () => json({ error: 'no_workers' }, 503) })
    vi.stubGlobal('fetch', fn)
    await expect(openTorrent(MAGNET)).rejects.toBeInstanceOf(NoWorkersError)

    const busy = fleetFetch({ 'POST /api/torrents': () => json({ error: 'workers_busy' }, 503) })
    vi.stubGlobal('fetch', busy.fn)
    await expect(openTorrent(MAGNET)).rejects.toBeInstanceOf(WorkersBusyError)
  })

  it('refuses a magnet without a hash before touching the network', async () => {
    const { fn } = fleetFetch({})
    vi.stubGlobal('fetch', fn)
    await expect(openTorrent('magnet:?dn=nothing')).rejects.toBeInstanceOf(TorrentRejectedError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('registers, waits for the listing, selects, and reads from the worker', async () => {
    let polls = 0
    const { fn, calls } = fleetFetch({
      'POST /api/torrents': (init) => {
        const body = JSON.parse(String(init?.body)) as { infoHash: string; trackers: string[]; dn: string }
        expect(body).toEqual({ infoHash: 'ab'.repeat(20), trackers: ['udp://t.example:1337'], dn: 'Show' })
        return json({ jobId: 'j1', state: 'resolving' }, 202)
      },
      'GET /api/torrents/j1': () => {
        polls += 1
        if (polls === 1) return json({ jobId: 'j1', state: 'resolving' })
        return json({
          jobId: 'j1', state: 'listed', name: 'Show',
          files: [
            { index: 0, name: 'notes.txt', path: 'notes.txt', size: 3 },
            { index: 1, name: 'episode.mkv', path: 'show/episode.mkv', size: 6 },
            { index: 2, name: 'episode.srt', path: 'show/episode.srt', size: 40 },
          ],
          swarm: { peers: 4, downSpeed: 100, haveBytes: 3, selectedBytes: 6 },
        })
      },
      'POST /api/torrents/j1/select': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ fileIndex: 1 })
        return json({ readBase: 'https://w.test', ticket: 'T1', expiresAt: new Date(Date.now() + 900_000).toISOString(), name: 'episode.mkv', size: 6, fileIndex: 1 })
      },
      'GET /v1/f/T1': (init) => {
        const range = String((init?.headers as Record<string, string>)?.Range)
        const [start, end] = range.replace('bytes=', '').split('-').map(Number)
        return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/6` } })
      },
      'DELETE /api/torrents/j1': () => new Response(null, { status: 204 }),
    })
    vi.stubGlobal('fetch', fn)

    const session = await openTorrent(MAGNET)
    expect(session.name).toBe('Show')
    expect(session.jobId).toBe('j1')
    expect(session.files.map((file) => file.name)).toEqual(['episode.mkv'])
    expect(session.subtitleFiles.map((file) => file.name)).toEqual(['episode.srt'])
    expect(session.files[0].worker).toBeUndefined()

    await session.select('show/episode.mkv')
    expect(session.files[0].worker).toMatchObject({ jobId: 'j1', readBase: 'https://w.test', ticket: 'T1', fileIndex: 1 })
    expect(session.subtitleFiles[0].streamUrl).toBe('https://w.test/v1/file/T1/2')
    await expect(session.files[0].read(0, 1)).resolves.toHaveProperty('byteLength', 2)
    const read = calls.find((call) => call.url.startsWith('https://w.test/v1/f/T1'))
    expect(read?.url).toBe('https://w.test/v1/f/T1?prio=head')
    expect((read!.init!.headers as Record<string, string>).Range).toBe('bytes=0-1')
    // The server is never in the byte path.
    expect(calls.filter((call) => call.url.startsWith('/api')).every((call) => !call.url.includes('/v1/'))).toBe(true)

    session.destroy()
    expect(calls.some((call) => call.url === '/api/torrents/j1' && call.init?.method === 'DELETE')).toBe(true)
  })

  it('a listing the worker refused is a rejection, and the job is released', async () => {
    const { fn, calls } = fleetFetch({
      'POST /api/torrents': () => json({ jobId: 'j2', state: 'resolving' }, 202),
      'GET /api/torrents/j2': () => json({ jobId: 'j2', state: 'failed', error: 'not_video' }),
      'DELETE /api/torrents/j2': () => new Response(null, { status: 204 }),
    })
    vi.stubGlobal('fetch', fn)
    const error = await openTorrent(MAGNET).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TorrentRejectedError)
    expect((error as TorrentRejectedError).code).toBe('not_video')
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true)
  })
})
