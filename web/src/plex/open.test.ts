import { describe, expect, it, vi } from 'vitest'
import { openPlexItem } from './open'

const item = {
  ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' as const,
  partKey: '/library/parts/9/1600/file.mkv', size: 1234567, container: 'mkv',
}

describe('openPlexItem', () => {
  it('lets the server pull when the connection is reachable from outside', () => {
    const open = openPlexItem(
      { uri: 'https://1-2-3-4.hash.plex.direct:32400', local: false, relay: false }, item, 'tok',
    )
    expect(open).toMatchObject({ kind: 'server-pull', size: 1234567 })
    expect(open.kind === 'server-pull' && open.url).toContain('X-Plex-Token=tok')
    expect(open.fileName).toBe('Duna.mkv')
  })

  it('pumps from the browser when the server is only reachable on the local network', () => {
    // The VPS cannot reach 10.0.0.5, and the SSRF guard will not be opened to
    // let it try. The host's browser is already on that network.
    const open = openPlexItem(
      { uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false }, item, 'tok',
    )
    expect(open.kind).toBe('browser-pump')
  })

  it('pumps from the browser for a relay too, because relay bandwidth is the account owner to spend', () => {
    const open = openPlexItem(
      { uri: 'https://relay.plex.direct:443', local: false, relay: true }, item, 'tok',
    )
    expect(open.kind).toBe('browser-pump')
  })
})

describe('the ranged source it hands over', () => {
  const open = openPlexItem(
    { uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false }, item, 'tok',
  )
  const source = open.kind === 'browser-pump' ? open.source : null

  it('asks for exactly the byte range the pump wants', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const chunk = await source!.read(100, 199)
    expect(chunk.byteLength).toBe(3)
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Range)
      .toBe('bytes=100-199')
    vi.unstubAllGlobals()
  })

  it('fails loudly when the origin ignores the range', async () => {
    // A 200 here means the whole file is coming, and writing that at a
    // non-zero offset corrupts the upload silently — the worst outcome.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 })))
    await expect(source!.read(100, 199)).rejects.toThrow(/range/i)
    vi.unstubAllGlobals()
  })

  it('names the Allow Downloads problem when plex refuses the original file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    await expect(source!.read(0, 99)).rejects.toThrow(/allow downloads/i)
    vi.unstubAllGlobals()
  })
})
