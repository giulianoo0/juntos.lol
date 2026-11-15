import { describe, expect, it, vi } from 'vitest'
import { appCall, appCalls, appRelay, extensionRelay, relayFor } from './relay'

const place = { base: 'ext.example', scheme: 'https' as const }

describe('extensionRelay', () => {
  it('pede ao juntos um ticket para a url e lê pelo proxy da extensão com ele', async () => {
    const get = vi.fn(async () => Response.json({ ticket: '1794100000.abc' }))
    const relay = extensionRelay('abcdefghijklmnop', place, get)

    const url = await relay.via('https://cdn.example.com/a b.mp4')

    expect(get).toHaveBeenCalledWith('/api/extensions/media-ticket', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sub: 'abcdefghijklmnop', url: 'https://cdn.example.com/a b.mp4' }),
    }))
    expect(url).toBe(`https://abcdefghijklmnop.ext.example/_juntos/media?u=${encodeURIComponent('https://cdn.example.com/a b.mp4')}&t=1794100000.abc`)
    expect(relay.owns(url)).toBe(true)
    expect(relay.owns('https://cdn.example.com/a.mp4')).toBe(false)
  })

  it('falha quando o juntos recusa o ticket', async () => {
    const relay = extensionRelay('abcdefghijklmnop', place, async () => Response.json({ error: 'human_required' }, { status: 403 }))
    await expect(relay.via('https://cdn.example.com/a.mp4')).rejects.toThrow('403')
  })
})

describe('appRelay', () => {
  const app = { version: '0.3.0', mediaRoot: 'juntos-media://localhost', features: ['mediaProxy'], mediaProxyKey: 'k/1', invoke: vi.fn() }

  it('lê pelo proxy do app com a chave e os headers', async () => {
    const relay = appRelay({ referer: 'https://site.example/' }, app)!
    const url = await relay.via('http://cdn.example.com/a.m3u8')
    const parsed = new URL(url.replace('juntos-media://localhost', 'https://x'))
    expect(url.startsWith('juntos-media://localhost/_proxy?')).toBe(true)
    expect(parsed.searchParams.get('u')).toBe('http://cdn.example.com/a.m3u8')
    expect(parsed.searchParams.get('k')).toBe('k/1')
    const h = parsed.searchParams.get('h')!.replace(/-/g, '+').replace(/_/g, '/')
    expect(JSON.parse(atob(h))).toEqual({ referer: 'https://site.example/' })
    expect(relay.owns(url)).toBe(true)
  })

  it('não existe no navegador nem num app sem o proxy', () => {
    expect(appRelay(undefined, null)).toBeUndefined()
    expect(appRelay(undefined, { ...app, features: [] })).toBeUndefined()
    expect(appRelay(undefined, { ...app, mediaProxyKey: undefined })).toBeUndefined()
  })
})

describe('appCall', () => {
  const app = { version: '0.3.0', mediaRoot: 'juntos-media://localhost', features: ['mediaProxy', 'extensionFetch'], mediaProxyKey: 'k1', invoke: vi.fn() }
  const call = { juntos: 1 as const, type: 'fetch' as const, nonce: 'n1', url: 'https://api.example.com/login', method: 'POST' as const, headers: { 'user-agent': 'app-android', 'content-type': 'application/json' }, body: '{"a":1}' }

  it('manda pelo proxy do app com os headers e devolve status, tipo e corpo', async () => {
    const get = vi.fn(async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }))

    const answer = await appCall(call, app, get)

    const [url, init] = get.mock.calls[0] as unknown as [string, RequestInit]
    const parsed = new URL(url.replace('juntos-media://localhost', 'https://x'))
    expect(parsed.pathname).toBe('/_proxy')
    expect(parsed.searchParams.get('u')).toBe('https://api.example.com/login')
    expect(parsed.searchParams.get('k')).toBe('k1')
    expect(JSON.parse(atob(parsed.searchParams.get('h')!.replace(/-/g, '+').replace(/_/g, '/')))).toEqual(call.headers)
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}' })
    expect(init.headers).toBeUndefined()
    expect(answer).toEqual({ juntos: 1, type: 'fetched', nonce: 'n1', status: 201, contentType: 'application/json', body: '{"ok":true}' })
  })

  it('responde status 0 sem o app, num app antigo ou quando a rede falha', async () => {
    const get = vi.fn(async () => { throw new TypeError('offline') })
    expect((await appCall(call, null, get)).status).toBe(0)
    expect((await appCall(call, { ...app, features: ['mediaProxy'] }, get)).status).toBe(0)
    expect(get).not.toHaveBeenCalled()
    expect(await appCall(call, app, get)).toEqual({ juntos: 1, type: 'fetched', nonce: 'n1', status: 0, body: '' })
    expect(appCalls(app)).toBe(true)
  })
})

describe('relayFor', () => {
  it('extensão de qualquer host não tem proxy no Worker', () => {
    expect(relayFor({ sub: 'abcdefghijklmnop', manifest: { hosts: { media: ['*'] } } }, place)).toBeUndefined()
    expect(relayFor({ sub: 'abcdefghijklmnop', manifest: { hosts: { media: ['cdn.example.com'] } } }, place)).toBeDefined()
  })
})
