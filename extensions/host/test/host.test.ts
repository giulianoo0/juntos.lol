import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index'

const env: Env = {
  JUNTOS_ORIGIN: 'https://juntos.lol',
  JUNTOS_ORIGINS: 'https://juntos.lol,http://localhost:5173',
  EXT_BASE: 'santamagia.com',
  EXT_SCHEME: 'https',
}

const EXT = 'lczfxd2q74zxknb5'
const SHA = 'a'.repeat(40)
const RAW = `https://raw.githubusercontent.com/dono/exemplo/${SHA}`
const GH_SUB = 'ghghghghghghghgh'

const extManifest = {
  id: 'exemplo',
  name: 'Exemplo',
  version: '1.0.0',
  protocol: 1,
  entry: 'index.html',
  hosts: {
    connect: ['api.exemplo.dev', 'api.hcaptcha.com'],
    images: ['img.exemplo.dev'],
    media: ['*.cdn.exemplo.dev'],
  },
  captcha: 'hcaptcha',
}
const plainManifest = { ...extManifest, id: 'plain', entry: 'app.html', hosts: { connect: [], images: [], media: [] }, captcha: undefined }

type Upstream = Record<string, (req: Request) => Response>
const json = (v: unknown) => () => Response.json(v)

function fakeFetch(extra: Upstream = {}) {
  const calls: Request[] = []
  const routes: Upstream = {
    [`https://juntos.lol/api/extensions/host/${EXT}`]: json({ id: 'exemplo', source: 'github:dono/exemplo' }),
    'https://juntos.lol/api/extensions/exemplo/latest': json({ sha: SHA }),
    [`https://juntos.lol/api/extensions/host/${GH_SUB}`]: json({ id: 'plain', source: 'github:dono/repo' }),
    'https://juntos.lol/api/extensions/plain/latest': json({ sha: SHA }),
    [`${RAW}/juntos.json`]: json(extManifest),
    [`${RAW}/index.html`]: () => new Response('<!doctype html><p>oi</p>', { headers: { 'set-cookie': 'a=b', 'content-type': 'text/plain' } }),
    [`${RAW}/assets/app-X_1.js`]: () => new Response('console.log(1)'),
    [`https://raw.githubusercontent.com/dono/repo/${SHA}/juntos.json`]: json(plainManifest),
    [`https://raw.githubusercontent.com/dono/repo/${SHA}/app.html`]: () => new Response('<p>gh</p>'),
    ...extra,
  }
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push(req)
    const h = routes[req.url]
    return h ? h(req) : new Response('nope', { status: 404 })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

async function get(path: string, opts: { sub?: string; init?: RequestInit; upstream?: Upstream } = {}) {
  const f = fakeFetch(opts.upstream)
  const res = await handle(new Request(`https://${opts.sub ?? EXT}.santamagia.com${path}`, opts.init), env, { fetch: f.fetch })
  return Object.assign(res, { calls: f.calls })
}

function csp(res: Response) {
  const map = new Map<string, string>()
  for (const part of (res.headers.get('content-security-policy') ?? '').split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/)
    if (name) map.set(name, vals.join(' '))
  }
  return map
}

describe('arquivos da extensão', () => {
  it('/ redireciona para a versão atual e o entry', async () => {
    const res = await get('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/@${SHA}/index.html`)
  })

  it('/ de fonte github redireciona para o sha mais recente', async () => {
    const res = await get('/', { sub: GH_SUB })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/@${SHA}/app.html`)
  })

  it('serve o arquivo com content-type pela extensão e sem cookies', async () => {
    const res = await get(`/@${SHA}/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('oi')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('serve js de subpasta', async () => {
    const res = await get(`/@${SHA}/assets/app-X_1.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('serve arquivo do github pelo sha', async () => {
    const res = await get(`/@${SHA}/app.html`, { sub: GH_SUB })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>gh</p>')
  })

  it.each([
    `/@${SHA}/../index.html`,
    `/@${SHA}/%2e%2e/index.html`,
    `/@${SHA}/a%2f..%2findex.html`,
    `/@${SHA}/..%5cindex.html`,
    `/@${SHA}/index.html%00.js`,
    `/@${SHA}/.env.json`,
    `/@${SHA}/index.php`,
    `/@${SHA}/index`,
    `/@${SHA}/`,
    '/@outra/index.html',
    '/@juntos/index.html',
    `/@${'b'.repeat(40)}/index.html`,
    '/index.html',
  ])('recusa %s com 404 sem buscar o arquivo', async (path) => {
    const res = await get(path)
    expect(res.status).toBe(404)
    expect(res.calls.some((c) => !c.url.includes('/api/') && !c.url.endsWith('/juntos.json'))).toBe(false)
  })

  it('github recusa versão que não é sha de 40 hex', async () => {
    expect((await get('/@nao-sha/app.html', { sub: GH_SUB })).status).toBe(404)
    expect((await get('/@main/app.html', { sub: GH_SUB })).status).toBe(404)
  })

  it('github só serve o sha atual do registro (commit de fork não entra pela rede do repo)', async () => {
    const other = 'b'.repeat(40)
    const res = await get(`/@${other}/app.html`, {
      sub: GH_SUB,
      upstream: {
        [`https://raw.githubusercontent.com/dono/repo/${other}/juntos.json`]: json(plainManifest),
        [`https://raw.githubusercontent.com/dono/repo/${other}/app.html`]: () => new Response('<script>fork</script>'),
      },
    })
    expect(res.status).toBe(404)
    expect(res.calls.some((c) => c.url.includes(other))).toBe(false)
  })

  it('busca os arquivos no GITHUB_RAW quando configurado', async () => {
    const f = fakeFetch({
      [`http://127.0.0.1:9/dono/exemplo/${SHA}/juntos.json`]: json(extManifest),
      [`http://127.0.0.1:9/dono/exemplo/${SHA}/index.html`]: () => new Response('<p>local</p>'),
    })
    const res = await handle(new Request(`https://${EXT}.santamagia.com/@${SHA}/index.html`), { ...env, GITHUB_RAW: 'http://127.0.0.1:9' }, { fetch: f.fetch })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>local</p>')
    expect(f.calls.some((c) => c.url.startsWith('https://raw.githubusercontent.com/'))).toBe(false)
  })

  it('logo depois de um push serve o sha novo em vez de 404 pelo latest guardado', async () => {
    const store = new Map<string, Response>()
    const cache = {
      match: async (key: string) => store.get(key)?.clone(),
      put: async (key: string, res: Response) => { store.set(key, res.clone()) },
      delete: async (key: string) => store.delete(key),
    } as unknown as Cache
    const NEW = 'c'.repeat(40)
    let head = SHA
    const f = fakeFetch({
      'https://juntos.lol/api/extensions/exemplo/latest': () => Response.json({ sha: head }),
      [`https://raw.githubusercontent.com/dono/exemplo/${NEW}/juntos.json`]: json(extManifest),
      [`https://raw.githubusercontent.com/dono/exemplo/${NEW}/index.html`]: () => new Response('<p>novo</p>'),
    })
    const at = (path: string) => handle(new Request(`https://${EXT}.santamagia.com${path}`), env, { fetch: f.fetch, cache })

    expect((await at('/')).headers.get('location')).toBe(`/@${SHA}/index.html`)
    head = NEW
    const res = await at(`/@${NEW}/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>novo</p>')
    expect((await at(`/@${SHA}/index.html`)).status).toBe(404)
  })

  it('sub desconhecido dá 404', async () => {
    expect((await get('/', { sub: 'zzzzzzzzzzzzzzzz' })).status).toBe(404)
    expect((await get(`/@${SHA}/index.html`, { sub: 'zzzzzzzzzzzzzzzz' })).status).toBe(404)
  })

  it('host fora da base dá 404 sem consultar o registro', async () => {
    const f = fakeFetch()
    const res = await handle(new Request(`https://${EXT}.evil.com/`), env, { fetch: f.fetch })
    expect(res.status).toBe(404)
    expect(f.calls).toHaveLength(0)
  })

  it('manifesto inválido não serve nada', async () => {
    const res = await get(`/@${SHA}/index.html`, {
      upstream: { [`${RAW}/juntos.json`]: json({ ...extManifest, protocol: 2 }) },
    })
    expect(res.status).toBe(502)
  })

  it('manifesto com id diferente do registrado não serve nada', async () => {
    const res = await get(`/@${SHA}/index.html`, {
      upstream: { [`${RAW}/juntos.json`]: json({ ...extManifest, id: 'outra' }) },
    })
    expect(res.status).toBe(502)
  })
})

describe('CSP', () => {
  it('vale também para svg: script inline nele não roda', async () => {
    const res = await get(`/@${SHA}/icon.svg`, {
      sub: GH_SUB,
      upstream: { [`https://raw.githubusercontent.com/dono/repo/${SHA}/icon.svg`]: () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(csp(res).get('script-src')).not.toContain('unsafe-inline')
    expect(csp(res).get('default-src')).toBe("'self'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('o Host decide a extensão: o sub de outra nunca serve os arquivos desta', async () => {
    const res = await get(`/@${SHA}/app.html`, { sub: GH_SUB })
    expect(res.calls.some((c) => c.url.startsWith(RAW))).toBe(false)
  })

  it('é montada do manifesto, com hCaptcha', async () => {
    const p = csp(await get(`/@${SHA}/index.html`))
    expect(p.get('default-src')).toBe("'self'")
    expect(p.get('frame-ancestors')).toBe('https://juntos.lol http://localhost:5173')
    expect(p.get('connect-src')).toBe("'self' https://api.exemplo.dev https://api.hcaptcha.com https://hcaptcha.com https://*.hcaptcha.com")
    expect(p.get('img-src')).toBe("'self' data: https://img.exemplo.dev")
    expect(p.get('script-src')).toBe("'self' https://js.hcaptcha.com https://*.hcaptcha.com")
    expect(p.get('frame-src')).toBe('https://hcaptcha.com https://*.hcaptcha.com')
    expect(p.get('base-uri')).toBe("'none'")
    expect(p.get('form-action')).toBe("'none'")
    expect(p.get('object-src')).toBe("'none'")
  })

  it('sem captcha não libera hCaptcha', async () => {
    const res = await get(`/@${SHA}/app.html`, { sub: GH_SUB })
    const p = csp(res)
    expect(p.get('script-src')).toBe("'self'")
    expect(p.get('frame-src')).toBe("'none'")
    expect(p.get('connect-src')).toBe("'self'")
    expect(p.get('img-src')).toBe("'self' data:")
    expect(res.headers.get('content-security-policy')).not.toContain('hcaptcha')
  })
})

describe('SDK', () => {
  it('serve /_juntos/sdk.js como javascript com as origens do juntos', async () => {
    const res = await get('/_juntos/sdk.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('["https://juntos.lol","http://localhost:5173"]')
  })
})

describe('proxy de mídia', () => {
  const seg = 'https://sa-east-1.cdn.exemplo.dev/a/1/seg1.ts?sig=1'
  const media = (u: string) => `/_juntos/media?u=${encodeURIComponent(u)}`
  const fromJuntos = (path: string, opts: { init?: RequestInit; upstream?: Upstream } = {}) => {
    const headers = new Headers(opts.init?.headers)
    if (!headers.has('origin')) headers.set('origin', 'https://juntos.lol')
    return get(path, { ...opts, init: { ...opts.init, headers } })
  }

  it.each([
    ['sem Origin (navegação, <video> de outro site, curl)', undefined],
    ['de origem fora da lista', 'https://evil.example'],
    ['de uma origem de extensão', 'https://abcdefghijklmnop.santamagia.com'],
  ])('só atende o juntos: recusa pedido %s sem buscar nada', async (_, origin) => {
    const res = await get(media(seg), {
      init: origin ? { headers: { origin } } : {},
      upstream: { [seg]: () => new Response('x') },
    })
    expect(res.status).toBe(403)
    expect(res.calls.some((c) => c.url === seg)).toBe(false)
  })

  it('repassa Range e devolve 206 com CORS para a origem do juntos', async () => {
    const res = await fromJuntos(media(seg), {
      init: { headers: { range: 'bytes=0-9', origin: 'https://juntos.lol' } },
      upstream: {
        [seg]: (req) =>
          new Response('0123456789', {
            status: 206,
            headers: { 'content-range': `bytes 0-9/100`, 'content-type': 'video/mp2t', 'set-cookie': 'x=1' },
          }),
      },
    })
    expect(res.status).toBe(206)
    expect(res.calls.find((c) => c.url === seg)?.headers.get('range')).toBe('bytes=0-9')
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://juntos.lol')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toBe('0123456789')
  })

  it('não devolve CORS para origem fora da lista', async () => {
    const res = await get(media(seg), {
      init: { headers: { origin: 'https://evil.com' } },
      upstream: { [seg]: () => new Response('x') },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each([
    ['host fora de hosts.media', 'https://cdn.exemplo.dev.evil.com/a.ts'],
    ['esquema http', 'http://sa-east-1.cdn.exemplo.dev/a.ts'],
    ['porta explícita', 'https://sa-east-1.cdn.exemplo.dev:8443/a.ts'],
    ['credenciais', 'https://u:p@sa-east-1.cdn.exemplo.dev/a.ts'],
    ['url inválida', 'nada'],
    ['IP de metadados da nuvem', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback em hex', 'https://0x7f000001/a.ts'],
    ['IPv6 local', 'https://[::1]/a.ts'],
    ['localhost', 'https://localhost/a.ts'],
  ])('recusa %s', async (_, u) => {
    const res = await fromJuntos(media(u), { upstream: { [u]: () => new Response('x') } })
    expect(res.status).toBe(403)
    expect(res.calls.some((c) => c.url === u)).toBe(false)
  })

  it('responde HEAD com os cabeçalhos e sem corpo', async () => {
    const res = await fromJuntos(media(seg), {
      init: { method: 'HEAD', headers: { origin: 'https://juntos.lol' } },
      upstream: { [seg]: (r) => new Response(r.method === 'HEAD' ? null : 'corpo', { headers: { 'content-length': '5' } }) },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('5')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://juntos.lol')
    expect(await res.text()).toBe('')
    expect(res.calls.find((c) => c.url === seg)?.method).toBe('HEAD')
  })

  it('recusa método diferente de GET', async () => {
    const res = await fromJuntos(media(seg), { init: { method: 'POST', body: 'x' }, upstream: { [seg]: () => new Response('x') } })
    expect(res.status).toBe(405)
    expect(res.calls.some((c) => c.url === seg)).toBe(false)
  })

  it('não segue redirecionamento para host fora da lista', async () => {
    const res = await fromJuntos(media(seg), {
      upstream: { [seg]: () => new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } }) },
    })
    expect(res.status).toBe(403)
    expect(res.calls.some((c) => c.url.startsWith('https://evil.com'))).toBe(false)
  })

  it('reescreve as URIs da playlist para o próprio proxy', async () => {
    const pl = 'https://sa-east-1.cdn.exemplo.dev/a/1/1080p.m3u8?policy=p&signature=s'
    const body = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-MAP:URI="init.mp4?k=1"',
      '#EXTINF:4.0,',
      'seg1.m4s?k=1',
      '',
      '#EXTINF:4.0,',
      'https://us.cdn.exemplo.dev/a/seg2.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const res = await fromJuntos(media(pl), {
      upstream: { [pl]: () => new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '999' } }) },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).not.toBe('999')
    const proxied = (u: string) => `https://${EXT}.santamagia.com/_juntos/media?u=${encodeURIComponent(u)}`
    expect((await res.text()).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-KEY:METHOD=NONE',
      `#EXT-X-MAP:URI="${proxied('https://sa-east-1.cdn.exemplo.dev/a/1/init.mp4?k=1')}"`,
      '#EXTINF:4.0,',
      proxied('https://sa-east-1.cdn.exemplo.dev/a/1/seg1.m4s?k=1'),
      '',
      '#EXTINF:4.0,',
      proxied('https://us.cdn.exemplo.dev/a/seg2.m4s'),
      '#EXT-X-ENDLIST',
    ])
  })

  it('recusa playlist acima de 4 MB sem reescrever', async () => {
    const pl = 'https://sa-east-1.cdn.exemplo.dev/a/grande.m3u8'
    const big = '#EXTM3U\n' + 'seg.ts\n'.repeat(700_000)
    const res = await fromJuntos(media(pl), { upstream: { [pl]: () => new Response(big, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) } })
    expect(res.status).toBe(502)
  })

  it('reescreve URI de EXT-X-KEY', async () => {
    const pl = 'https://sa-east-1.cdn.exemplo.dev/a/p.m3u8'
    const res = await fromJuntos(media(pl), {
      upstream: { [pl]: () => new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x1\n') },
    })
    expect(await res.text()).toContain(
      `#EXT-X-KEY:METHOD=AES-128,URI="https://${EXT}.santamagia.com/_juntos/media?u=${encodeURIComponent('https://sa-east-1.cdn.exemplo.dev/a/k.bin')}",IV=0x1`,
    )
  })
})
