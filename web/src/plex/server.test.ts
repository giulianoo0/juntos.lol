import { describe, expect, it, vi } from 'vitest'
import { listServers, pickConnection, type PlexServer } from './server'

const resources = [
  {
    name: 'Casa', clientIdentifier: 'srv1', provides: 'server',
    connections: [
      { uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false },
      { uri: 'https://1-2-3-4.hash.plex.direct:32400', local: false, relay: false },
      { uri: 'https://relay.plex.direct:443', local: false, relay: true },
    ],
  },
  { name: 'Um telefone', clientIdentifier: 'p1', provides: 'player,controller', connections: [] },
]

const server = resources[0] as unknown as PlexServer

describe('listServers', () => {
  it('keeps the servers and drops everything else on the account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resources), { status: 200 }))
    const servers = await listServers('tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(servers.map((entry) => entry.name)).toEqual(['Casa'])
    expect(servers[0].connections).toHaveLength(3)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('includeHttps=1')
    expect(url).toContain('includeRelay=1')
    expect((init.headers as Record<string, string>)['X-Plex-Token']).toBe('tok')
  })

  it('survives an answer that is not the shape it should be', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(listServers('tok', { fetch: fetchMock as unknown as typeof fetch })).resolves.toEqual([])
  })
})

describe('pickConnection', () => {
  it('takes the first connection that answers, not the first in the list', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      // The LAN address is listed first and is the one that does not answer.
      if (String(input).startsWith('https://10-0-0-5')) throw new Error('unreachable')
      return new Response('{}', { status: 200 })
    })
    const chosen = await pickConnection(server, 'tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(chosen.uri).toBe('https://1-2-3-4.hash.plex.direct:32400')
  })

  it('prefers the LAN when the LAN answers, because relay is metered and slow', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    const chosen = await pickConnection(server, 'tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(chosen.local).toBe(true)
  })

  it('probes without custom headers, so no CORS preflight doubles the latency', async () => {
    const seen: (RequestInit | undefined)[] = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init)
      return new Response('{}', { status: 200 })
    })
    await pickConnection(server, 'tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(seen[0]?.headers).toBeUndefined()
  })

  it('says so when nothing answers, rather than returning a connection that does not work', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('unreachable') })
    await expect(pickConnection(server, 'tok', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/no reachable/i)
  })
})
