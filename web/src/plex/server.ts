import { plexHeaders, type PlexDeps } from './account'

export interface PlexConnection {
  uri: string
  local: boolean
  relay: boolean
}

export interface PlexServer {
  name: string
  clientIdentifier: string
  connections: PlexConnection[]
}

/** How long a connection gets to prove it is reachable. */
const PROBE_TIMEOUT_MS = 4_000

export async function listServers(token: string, deps: PlexDeps = {}): Promise<PlexServer[]> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: { ...await plexHeaders(), 'X-Plex-Token': token },
  })
  if (!response.ok) throw new Error(`plex resources failed (${response.status})`)
  const body = await response.json() as unknown
  if (!Array.isArray(body)) return []
  return body
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    // `provides` is a comma-separated string, and the same account also lists
    // phones and players.
    .filter((entry) => typeof entry.provides === 'string' && entry.provides.split(',').includes('server'))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : 'Plex',
      clientIdentifier: typeof entry.clientIdentifier === 'string' ? entry.clientIdentifier : '',
      connections: (Array.isArray(entry.connections) ? entry.connections : [])
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .filter((c) => typeof c.uri === 'string' && c.uri.startsWith('https://'))
        .map((c) => ({
          uri: c.uri as string,
          local: c.local === true || c.local === 1,
          relay: c.relay === true || c.relay === 1,
        })),
    }))
}

/**
 * Finds a connection that actually works.
 *
 * Which one that is cannot be decided on paper: a LAN address is the fastest
 * when the host is at home and unreachable when they are not, and a relay
 * always works and is metered. So every connection is probed at once and the
 * ranking only breaks ties among the ones that answered.
 *
 * The LAN address is HTTPS with a real certificate because of plex.direct,
 * which is a DNS trick: 10-0-0-5.<hash>.plex.direct resolves to 10.0.0.5 and
 * carries a wildcard cert. It is the only reason a page on ss.giuli.dev can
 * talk to a box on someone's home network at all.
 */
export async function pickConnection(server: PlexServer, _token: string, deps: PlexDeps = {}): Promise<PlexConnection> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)

  const reachable = await Promise.all(server.connections.map(async (connection) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
    try {
      // No custom headers on the probe. `/identity` needs no token, and any
      // X-Plex-* header would trigger a CORS preflight — doubling the latency
      // of every probe and eating into the four seconds each one gets.
      const response = await request(`${connection.uri}/identity`, { signal: abort.signal })
      return response.ok ? connection : null
    } catch {
      // A LAN address from outside the LAN, or a router refusing a DNS answer
      // that points at a private address. Neither is worth reporting on its
      // own; what matters is whether anything answered.
      return null
    } finally {
      clearTimeout(timer)
    }
  }))

  const answered = reachable.filter((connection): connection is PlexConnection => connection !== null)
  if (answered.length === 0) throw new Error('plex: no reachable connection to this server')
  const rank = (connection: PlexConnection) => (connection.local ? 0 : connection.relay ? 2 : 1)
  return answered.sort((a, b) => rank(a) - rank(b))[0]
}
