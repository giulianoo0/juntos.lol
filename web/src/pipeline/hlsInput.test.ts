import { describe, expect, it, vi } from 'vitest'
import { hlsInput, openHls } from './hlsInput'
import { UnsupportedMediaError } from './unsupported'

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (seed + i) % 256)

/** A CDN in memory: playlists as text, files as bytes, Range honoured, HEAD answered. */
function cdn(files: Record<string, string | Uint8Array>, { onHead }: { onHead?: (url: string) => Promise<void> | void } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const body = files[path]
    if (body === undefined) return new Response(null, { status: 404 })
    const data = typeof body === 'string' ? new TextEncoder().encode(body) : body
    if (init?.method === 'HEAD') {
      await onHead?.(url)
      return new Response(null, { status: 200, headers: { 'Content-Length': String(data.byteLength) } })
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '')
    if (!range) return new Response(data.slice(), { status: 200 })
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), data.byteLength - 1)
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` },
    })
  })
}

const media = (lines: string[]) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ...lines, '#EXT-X-ENDLIST'].join('\n')


const extRelay = {
  via: async (url: string) => `https://ext.example/_juntos/media?u=${encodeURIComponent(url)}`,
  owns: (url: string) => url.startsWith('https://ext.example/_juntos/media?'),
}

describe('HLS como um arquivo só', () => {
  it('soma os segmentos e lê atravessando de um para o outro', async () => {
    const a = bytes(100, 0)
    const b = bytes(60, 100)
    const fetch = cdn({
      '/ep/1080p.m3u8': media(['#EXTINF:6.0,', 'seg0.ts', '#EXTINF:4.0,', 'seg1.ts']),
      '/ep/seg0.ts': a,
      '/ep/seg1.ts': b,
    })

    const input = await hlsInput('https://us-east-2.cdn-exemplo.net/ep/1080p.m3u8?signature=s', 'Emma', { fetch })

    expect(input.size).toBe(160)
    expect(input.name).toBe('Emma')
    expect(await input.read(90, 110)).toEqual(Uint8Array.from([...a.slice(90), ...b.slice(0, 10)]))
    expect(await input.read(150, 160)).toEqual(b.slice(50))
  })

  it('escolhe a variante mais pesada da playlist mestre', async () => {
    const fetch = cdn({
      '/ep/master.m3u8': [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
        '480p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
        'hi/1080p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
        '720p.m3u8',
      ].join('\n'),
      '/ep/480p.m3u8': media(['#EXTINF:6,', 'low.ts']),
      '/ep/hi/1080p.m3u8': media(['#EXTINF:6,', 'high.ts']),
      '/ep/hi/high.ts': bytes(30, 7),
      '/ep/low.ts': bytes(10, 1),
    })

    const input = await hlsInput('https://cdn.example.com/ep/master.m3u8', 'Emma', { fetch })

    expect(input.size).toBe(30)
    expect(await input.read(0, 30)).toEqual(bytes(30, 7))
  })

  it.each(['AES-128', 'SAMPLE-AES'])('recusa EXT-X-KEY com METHOD=%s', async (method) => {
    const fetch = cdn({
      '/ep/1080p.m3u8': media([`#EXT-X-KEY:METHOD=${method},URI="key.bin"`, '#EXTINF:6,', 'seg0.ts']),
      '/ep/seg0.ts': bytes(10, 0),
    })

    const failure = await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UnsupportedMediaError)
    expect((failure as UnsupportedMediaError).reason).toBe('encrypted')
  })

  it('aceita EXT-X-KEY com METHOD=NONE', async () => {
    const fetch = cdn({
      '/ep/1080p.m3u8': media(['#EXT-X-KEY:METHOD=NONE', '#EXTINF:6,', 'seg0.ts']),
      '/ep/seg0.ts': bytes(10, 0),
    })

    expect((await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch })).size).toBe(10)
  })

  it('em fMP4 começa pelo segmento de inicialização do EXT-X-MAP', async () => {
    const init = bytes(24, 200)
    const fetch = cdn({
      '/ep/1080p.m3u8': media(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'seg0.m4s', '#EXTINF:6,', 'seg1.m4s']),
      '/ep/init.mp4': init,
      '/ep/seg0.m4s': bytes(40, 0),
      '/ep/seg1.m4s': bytes(40, 40),
    })

    const input = await hlsInput('https://cdn.example.com/ep/1080p.m3u8', 'Emma', { fetch })

    expect(input.size).toBe(104)
    expect(await input.read(0, 30)).toEqual(Uint8Array.from([...init, ...bytes(6, 0)]))
  })

  it('segue EXT-X-BYTERANGE dentro de um arquivo só, sem medir nada', async () => {
    const whole = bytes(300, 3)
    const fetch = cdn({
      '/ep/1080p.m3u8': media(['#EXTINF:6,', '#EXT-X-BYTERANGE:100@50', 'all.ts', '#EXTINF:6,', '#EXT-X-BYTERANGE:80', 'all.ts']),
      '/ep/all.ts': whole,
    })

    const input = await hlsInput('https://cdn.example.com/ep/1080p.m3u8', 'Emma', { fetch })

    expect(input.size).toBe(180)
    expect(await input.read(95, 110)).toEqual(whole.slice(145, 160))
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'HEAD')).toBe(false)
  })

  it('mede os segmentos no máximo 32 de cada vez', async () => {
    let inFlight = 0
    let most = 0
    const files: Record<string, string | Uint8Array> = {
      '/ep/1080p.m3u8': media(Array.from({ length: 80 }, (_, i) => [`#EXTINF:6,`, `s${i}.ts`]).flat()),
    }
    for (let i = 0; i < 80; i++) files[`/ep/s${i}.ts`] = bytes(5, i)
    const fetch = cdn(files, {
      onHead: async () => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
    })

    const plan = await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch })

    expect(plan.size).toBe(400)
    expect(most).toBe(32)
  })

  it('refaz tudo pelo proxy da extensão quando o CDN não deixa ler (CORS)', async () => {
    const proxied = cdn({
      '/_juntos/media': media(['#EXTINF:6,', 'https://ext.example/_juntos/media?u=seg']),
    })
    const segment = bytes(12, 9)
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.host === 'us-east-2.cdn-exemplo.net') throw new TypeError('Failed to fetch')
      if (url.searchParams.get('u') === 'seg') {
        return init?.method === 'HEAD'
          ? new Response(null, { status: 405 })
          : new Response(segment.slice(0, 1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${segment.byteLength}` } })
      }
      return proxied(input, init)
    })

    const plan = await openHls('https://us-east-2.cdn-exemplo.net/ep/1080p.m3u8?signature=s', { fetch, relay: extRelay })

    expect(fetch).toHaveBeenCalledWith(
      `https://ext.example/_juntos/media?u=${encodeURIComponent('https://us-east-2.cdn-exemplo.net/ep/1080p.m3u8?signature=s')}`,
      expect.anything(),
    )
    expect(plan.segments.map((segment) => segment.url)).toEqual(['https://ext.example/_juntos/media?u=seg'])
    expect(plan.size).toBe(12)
  })

  it.each([
    ['variante na rede local', ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'http://127.0.0.1:40392/state.m3u8'].join('\n'), 'http://127.0.0.1:40392/state.m3u8'],
    ['segmento em host não declarado', media(['#EXTINF:6,', 'https://evil.example/seg.ts']), 'https://evil.example/seg.ts'],
    ['init do EXT-X-MAP no próprio juntos', media(['#EXT-X-MAP:URI="https://juntos.lol/api/me"', '#EXTINF:6,', 'seg.m4s']), 'https://juntos.lol/api/me'],
  ])('recusa playlist com %s sem buscar nada lá', async (_, playlist, outside) => {
    const fetch = cdn({ '/ep/1080p.m3u8': playlist, '/ep/seg.m4s': bytes(10, 0), '/seg.ts': bytes(10, 0), '/state.m3u8': media(['#EXTINF:6,', 'a.ts']), '/api/me': bytes(10, 0) })
    const allow = (url: string) => new URL(url).hostname.endsWith('.media.example')

    await expect(openHls('https://a.media.example/ep/1080p.m3u8', { fetch, allow })).rejects.toThrow(/outside/)
    expect(fetch.mock.calls.some(([url]) => String(url) === outside)).toBe(false)
  })

  it('lê de um CDN que ignora Range e recusa HEAD, baixando cada segmento uma vez só', async () => {
    const a = bytes(100, 0)
    const b = bytes(60, 100)
    const files: Record<string, Uint8Array | string> = {
      '/ep/720p.m3u8': media(['#EXTINF:6.0,', '720p_000.ts?signature=x', '#EXTINF:4.0,', '720p_001.ts?signature=y']),
      '/ep/720p_000.ts': a,
      '/ep/720p_001.ts': b,
    }
    // Like the signed CDN in front of real extensions: 405 to HEAD, the whole file to any GET.
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = files[new URL(String(input)).pathname]
      if (body === undefined) return new Response(null, { status: 404 })
      if (init?.method === 'HEAD') return new Response(null, { status: 405 })
      const data = typeof body === 'string' ? new TextEncoder().encode(body) : body
      return new Response(data.slice(), { status: 200, headers: { 'Content-Length': String(data.byteLength) } })
    })

    const input = await hlsInput('https://wk3.cdn-exemplo.net/ep/720p.m3u8?policy=p', 'Emma', { fetch })
    fetch.mockClear()

    expect(input.size).toBe(160)
    expect(await input.read(90, 110)).toEqual(Uint8Array.from([...a.slice(90), ...b.slice(0, 10)]))
    expect(await input.read(10, 20)).toEqual(a.slice(10, 20))
    expect(await input.read(150, 160)).toEqual(b.slice(50))
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/ep/720p_000.ts', '/ep/720p_001.ts'])
  })

  it('depois que o CDN recusa HEAD, os segmentos seguintes vão direto ao GET', async () => {
    const files: Record<string, string | Uint8Array> = {
      '/ep/1080p.m3u8': media(Array.from({ length: 200 }, (_, i) => [`#EXTINF:6,`, `s${i}.ts`]).flat()),
    }
    for (let i = 0; i < 200; i++) files[`/ep/s${i}.ts`] = bytes(5, i)
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = files[new URL(String(input)).pathname]
      if (init?.method === 'HEAD') return new Response(null, { status: 405 })
      const data = typeof body === 'string' ? new TextEncoder().encode(body) : body
      return new Response(data.slice(), { status: 200, headers: { 'Content-Length': String(data.byteLength) } })
    })

    const plan = await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch })

    expect(plan.size).toBe(1000)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'HEAD').length).toBeLessThanOrEqual(32)
  })

  it('nenhum pedido segue redirecionamento', async () => {
    const fetch = cdn({ '/ep/1080p.m3u8': media(['#EXTINF:6,', 'seg0.ts']), '/ep/seg0.ts': bytes(10, 0) })

    const input = await hlsInput('https://cdn.example.com/ep/1080p.m3u8', 'Emma', { fetch })
    await input.read(0, 10)

    expect(fetch.mock.calls.length).toBeGreaterThan(1)
    for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe('error')
  })

  it('volta tudo pelo proxy quando só os segmentos não deixam ler (CORS ou redirecionamento)', async () => {
    const segment = bytes(12, 9)
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.host === 'cdn.example.com') {
        if (url.pathname === '/ep/1080p.m3u8') return new Response(media(['#EXTINF:6,', 'seg0.ts']))
        throw new TypeError('Failed to fetch')
      }
      if (url.searchParams.get('u') === 'https://cdn.example.com/ep/1080p.m3u8') {
        return new Response(media(['#EXTINF:6,', 'https://ext.example/_juntos/media?u=seg']))
      }
      return init?.method === 'HEAD'
        ? new Response(null, { status: 405 })
        : new Response(segment.slice(0, 1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${segment.byteLength}` } })
    })

    const plan = await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch, relay: extRelay })

    expect(plan.segments.map((s) => s.url)).toEqual(['https://ext.example/_juntos/media?u=seg'])
    expect(plan.size).toBe(12)
  })

  it('na mestre com áudio à parte, prefere a variante que leva o próprio áudio', async () => {
    const fetch = cdn({
      '/ep/master.m3u8': [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="pt",URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=9000000,AUDIO="aud"', 'hi.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000', 'muxed.m3u8',
      ].join('\n'),
      '/ep/muxed.m3u8': media(['#EXTINF:6,', 'seg0.ts']),
      '/ep/seg0.ts': bytes(10, 0),
    })

    const plan = await openHls('https://cdn.example.com/ep/master.m3u8', { fetch })

    expect(plan.segments.map((s) => new URL(s.url).pathname)).toEqual(['/ep/seg0.ts'])
  })

  it.each([
    ['só com áudio à parte', 'separate audio', ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', 'v.m3u8'].join('\n')],
    ['com dois EXT-X-MAP', 'several init segments', media(['#EXT-X-MAP:URI="i1.mp4"', '#EXTINF:6,', 's1.m4s', '#EXT-X-MAP:URI="i2.mp4"', '#EXTINF:6,', 's2.m4s'])],
    ['sem EXT-X-ENDLIST (ao vivo)', 'live', ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 's.ts'].join('\n')],
  ])('recusa playlist %s', async (_, reason, playlist) => {
    const fetch = cdn({ '/ep/p.m3u8': playlist })

    const error = await openHls('https://cdn.example.com/ep/p.m3u8', { fetch }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UnsupportedMediaError)
    expect((error as UnsupportedMediaError).reason).toBe(reason)
  })

  it('reaproveita o plano já aberto sem buscar a playlist de novo', async () => {
    const fetch = cdn({
      '/ep/1080p.m3u8': media(['#EXTINF:6,', 'seg0.ts']),
      '/ep/seg0.ts': bytes(10, 0),
    })
    const plan = await openHls('https://cdn.example.com/ep/1080p.m3u8', { fetch })
    fetch.mockClear()

    const input = await hlsInput('https://cdn.example.com/ep/1080p.m3u8', 'Emma', { fetch, plan })

    expect(await input.read(0, 10)).toEqual(bytes(10, 0))
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/ep/seg0.ts'])
  })
})
