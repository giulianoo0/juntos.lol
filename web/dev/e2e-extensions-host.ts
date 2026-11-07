// The extension host as e2e-extensions.mjs runs it in mock mode: the real
// Worker, except that its fetches to the extension's media hosts land on the
// e2e's fake CDN, so the media proxy is exercised without the internet.
import { handle, type Env } from '../../extensions/host/src/index'

interface MockEnv extends Env {
  /** host:port of the fake CDN. */
  FAKE_CDN: string
  /** The manifest's media hosts, comma separated (`*.domain` allowed). */
  FAKE_CDN_HOSTS: string
}

function faked(hostname: string, hosts: string[]): boolean {
  return hosts.some((h) => (h.startsWith('*.') ? hostname.endsWith(h.slice(1)) : hostname === h))
}

function toFakeCdn(input: RequestInfo | URL, env: MockEnv): RequestInfo | URL {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (!faked(url.hostname, env.FAKE_CDN_HOSTS.split(','))) return input
  return `http://${env.FAKE_CDN}${url.pathname}${url.search}`
}

export default {
  fetch(req: Request, env: MockEnv): Promise<Response> {
    return handle(req, env, {
      fetch: (input, init) => fetch(toFakeCdn(input, env), init),
      cache: caches.default,
    })
  },
} satisfies ExportedHandler<MockEnv>
