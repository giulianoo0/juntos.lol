import { hostAllowed, type ExtensionManifest } from './manifest'
import { checkTicket, signTicket } from './ticket'

interface MediaContext {
  origins: string[]
  self: string
  sub: string
  /** The key tickets are signed with (EXTENSION_MEDIA_KEY in juntos); empty lets nothing through. */
  key: string
  fetch: typeof fetch
  now?: () => number
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']
const MAX_REDIRECTS = 3

function allowedUrl(raw: string | null, m: ExtensionManifest): URL | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null
  return hostAllowed(u.hostname, m.hosts.media) ? u : null
}

/** Every uri of the playlist through this proxy, each with a ticket that ends with the playlist's. */
async function rewritePlaylist(text: string, base: URL, ctx: MediaContext, exp: number): Promise<string> {
  const proxied = async (ref: string) => {
    let url: string
    try {
      url = new URL(ref, base).href
    } catch {
      return ref
    }
    const t = await signTicket(ctx.key, ctx.sub, url, exp)
    return `${ctx.self}/_juntos/media?u=${encodeURIComponent(url)}&t=${encodeURIComponent(t)}`
  }
  const lines = await Promise.all(text.split('\n').map(async (line) => {
    const t = line.trim()
    if (!t) return line
    if (!t.startsWith('#')) return proxied(t)
    const refs = [...line.matchAll(/URI="([^"]*)"/g)].map((m) => m[1])
    const signed = await Promise.all(refs.map(proxied))
    let i = 0
    return line.replace(/URI="([^"]*)"/g, () => `URI="${signed[i++]}"`)
  }))
  return lines.join('\n')
}

function isPlaylist(url: URL, res: Response): boolean {
  return /mpegurl/i.test(res.headers.get('content-type') ?? '') || url.pathname.endsWith('.m3u8')
}

// A playlist is read whole to be rewritten; a media host that sends more than
// this is not sending a playlist.
const MAX_PLAYLIST_BYTES = 4 << 20

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel()
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength }
  return new TextDecoder().decode(all)
}

export async function proxyMedia(req: Request, m: ExtensionManifest, ctx: MediaContext): Promise<Response> {
  const origin = req.headers.get('origin')
  const headers = new Headers({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "sandbox; default-src 'none'",
    vary: 'Origin',
  })
  // Only juntos reads through here: without its Origin this would be an open
  // relay to the media hosts, for any page or script.
  if (!origin || !ctx.origins.includes(origin)) return new Response(null, { status: 403, headers })
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers.set('allow', 'GET, HEAD')
    return new Response(null, { status: 405, headers })
  }

  const params = new URL(req.url).searchParams
  const asked = params.get('u')
  // The Origin above is something any script can write; the ticket comes
  // from juntos itself, for this url and this extension, and expires.
  const exp = asked ? await checkTicket(ctx.key, ctx.sub, asked, params.get('t'), (ctx.now ?? Date.now)()) : null
  if (exp === null) return new Response(null, { status: 403, headers })
  let target = allowedUrl(asked, m)
  const range = req.headers.get('range')
  let res: Response | null = null
  for (let hop = 0; target && hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await ctx.fetch(target.href, { method: req.method, headers: range ? { range } : {}, redirect: 'manual' })
    } catch {
      return new Response(null, { status: 502, headers })
    }
    if (res.status < 300 || res.status >= 400) break
    const next = URL.parse(res.headers.get('location') ?? '', target.href)
    target = next ? allowedUrl(next.href, m) : null
    res = null
  }
  if (!target || !res) return new Response(null, { status: 403, headers })

  if (res.ok && req.method === 'GET' && isPlaylist(target, res)) {
    headers.set('content-type', res.headers.get('content-type') ?? 'application/vnd.apple.mpegurl')
    headers.set('cache-control', 'no-store')
    const text = await readCapped(res, MAX_PLAYLIST_BYTES)
    if (text === null) return new Response(null, { status: 502, headers })
    return new Response(await rewritePlaylist(text, target, ctx, exp), { status: 200, headers })
  }
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h)
    if (v) headers.set(h, v)
  }
  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, headers })
}
