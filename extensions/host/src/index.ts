import { securityHeaders } from './csp'
import { proxyMedia } from './media'
import { contentTypeFor, route } from './route'
import sdkSource from './sdk.gen'
import { currentVersion, fileUrl, GITHUB_RAW, loadManifest, lookupSub, UpstreamError, type Deps } from './sources'

export interface Env {
  JUNTOS_ORIGIN: string
  JUNTOS_ORIGINS: string
  EXT_BASE: string
  EXT_SCHEME: string
  GITHUB_RAW?: string
}

const SUB = /^[a-z2-7]{16}$/

const notFound = () => new Response('not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } })

function subOf(req: Request, env: Env): string | null {
  const host = new URL(req.url).host.toLowerCase()
  const suffix = `.${env.EXT_BASE}`
  if (!host.endsWith(suffix)) return null
  const sub = host.slice(0, -suffix.length)
  return SUB.test(sub) ? sub : null
}

function sdkResponse(origins: string[]): Response {
  return new Response(`(function(JUNTOS_ORIGINS){${sdkSource}})(${JSON.stringify(origins)});`, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  })
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const sub = subOf(req, env)
  const r = route(new URL(req.url).pathname)
  if (!sub || !r) return notFound()
  const origins = env.JUNTOS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  if (r.kind === 'sdk') return sdkResponse(origins)

  const rawBase = env.GITHUB_RAW || GITHUB_RAW
  try {
    const reg = await lookupSub(sub, env.JUNTOS_ORIGIN, deps)
    if (!reg) return notFound()
    let latest = await currentVersion(reg, env.JUNTOS_ORIGIN, deps)
    const version = r.kind === 'file' ? r.version : latest
    // Right after a push the page already knows the new sha; this host may
    // still hold the old one for up to a minute.
    if (version !== latest) latest = await currentVersion(reg, env.JUNTOS_ORIGIN, deps, true)
    if (version !== latest) return notFound()
    const manifest = await loadManifest(reg, version, rawBase, deps)
    if (!manifest) return notFound()

    if (r.kind === 'root') {
      return new Response(null, { status: 302, headers: { location: `/@${version}/${manifest.entry}`, 'cache-control': 'no-store' } })
    }
    if (r.kind === 'media') {
      return proxyMedia(req, manifest, { origins, self: `${env.EXT_SCHEME}://${sub}.${env.EXT_BASE}`, fetch: deps.fetch })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })

    const url = fileUrl(reg, version, r.path, rawBase)
    if (!url) return notFound()
    let upstream: Response
    try {
      upstream = await deps.fetch(url, { redirect: 'manual' })
    } catch {
      throw new UpstreamError(url)
    }
    if (upstream.status !== 200) return notFound()
    const headers = securityHeaders(manifest, origins)
    headers.set('content-type', contentTypeFor(r.path)!)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    return new Response(req.method === 'HEAD' ? null : upstream.body, { status: 200, headers })
  } catch (e) {
    if (e instanceof UpstreamError) return new Response('bad gateway', { status: 502 })
    throw e
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { fetch: (input, init) => fetch(input, init), cache: caches.default })
  },
} satisfies ExportedHandler<Env>
