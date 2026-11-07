import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionOrigin, parseExtMessage, urlAllowed, type ExtensionManifest } from './protocol'

const manifest: ExtensionManifest = {
  id: 'exemplo',
  name: 'Exemplo',
  version: '1.0.0',
  protocol: 1,
  entry: 'index.html',
  hosts: { connect: ['prod-api.exemplo.com'], images: ['cdn.exemplo.com'], media: ['*.cdn-exemplo.net', 'files.example.com'] },
}

const play = (extra: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => ({
  juntos: 1,
  type: 'play',
  title: 'Emma',
  ref: '15228',
  source: { kind: 'hls', url: 'https://sa-east-1.cdn-exemplo.net/1320/15228/1080p.m3u8?signature=x', ...source },
  ...extra,
})

describe('mensagens da extensão', () => {
  it.each([
    ['ready', { juntos: 1, type: 'ready' }],
    ['close', { juntos: 1, type: 'close' }],
    ['toast', { juntos: 1, type: 'toast', text: 'Sessão expirada' }],
    ['play', play()],
    ['play com subtítulo e capa', play({ subtitle: '1. Emma', poster: 'https://cdn.exemplo.com/a.jpg' })],
    ['play de arquivo', play({}, { kind: 'file', url: 'https://files.example.com/a.mp4' })],
    ['refreshed', { juntos: 1, type: 'refreshed', nonce: 'n1', source: { kind: 'hls', url: 'https://us-east-2.cdn-exemplo.net/a.m3u8' } }],
    ['refreshed sem fonte', { juntos: 1, type: 'refreshed', nonce: 'n1', source: null }],
    ['url assinada longa', play({}, { url: `https://sa-east-1.cdn-exemplo.net/1320/15228/1080p.m3u8?policy=${'p'.repeat(300)}&signature=${'s'.repeat(100)}` })],
  ])('aceita %s', (_, message) => {
    expect(parseExtMessage(message, manifest)).toEqual(message)
  })

  it('devolve só os campos do protocolo', () => {
    expect(parseExtMessage({ juntos: 1, type: 'ready', extra: '<b>x</b>' }, manifest)).toEqual({ juntos: 1, type: 'ready' })
  })

  it.each([
    ['outra versão do protocolo', { juntos: 2, type: 'ready' }],
    ['sem versão', { type: 'ready' }],
    ['tipo desconhecido', { juntos: 1, type: 'navigate' }],
    ['não objeto', 'ready'],
    ['nulo', null],
    ['array', [1, 'ready']],
    ['título gigante', play({ title: 'a'.repeat(301) })],
    ['ref longa', play({ ref: 'a'.repeat(129) })],
    ['url acima de 2048', play({}, { url: `https://sa-east-1.cdn-exemplo.net/a.m3u8?x=${'a'.repeat(2048)}` })],
    ['título em array', play({ title: ['Emma'] })],
    ['título objeto', play({ title: { toString: () => 'Emma' } })],
    ['javascript:', play({}, { url: 'javascript:alert(1)' })],
    ['data:', play({}, { url: 'data:video/mp4;base64,AAAA' })],
    ['http:', play({}, { url: 'http://sa-east-1.cdn-exemplo.net/a.m3u8' })],
    ['host de mídia não declarado', play({}, { url: 'https://evil.com/a.m3u8' })],
    ['curinga que não casa com sufixo falso', play({}, { url: 'https://cdn-exemplo.net.evil.com/a.m3u8' })],
    ['o domínio do curinga sem subdomínio', play({}, { url: 'https://cdn-exemplo.net/a.m3u8' })],
    ['url com credenciais', play({}, { url: 'https://user:pw@sa-east-1.cdn-exemplo.net/a.m3u8' })],
    ['url com porta', play({}, { url: 'https://sa-east-1.cdn-exemplo.net:8443/a.m3u8' })],
    ['tipo de fonte desconhecido', play({}, { kind: 'dash' })],
    ['capa fora de hosts.images', play({ poster: 'https://evil.com/a.jpg' })],
    ['capa em http', play({ poster: 'http://cdn.exemplo.com/a.jpg' })],
    ['toast vazio de texto', { juntos: 1, type: 'toast', text: 7 }],
    ['refreshed sem nonce', { juntos: 1, type: 'refreshed', source: null }],
  ])('recusa %s', (_, message) => {
    expect(parseExtMessage(message, manifest)).toBeNull()
  })

  it('um refreshed com fonte fora de hosts.media vale como sem fonte, para o host não esperar à toa', () => {
    const message = { juntos: 1, type: 'refreshed', nonce: 'n1', source: { kind: 'hls', url: 'https://evil.com/a.m3u8' } }
    expect(parseExtMessage(message, manifest)).toEqual({ juntos: 1, type: 'refreshed', nonce: 'n1', source: null })
  })

  it('recusa objeto com protótipo estranho', () => {
    const forged = Object.create({ juntos: 1, type: 'ready' }) as object
    expect(parseExtMessage(forged, manifest)).toBeNull()
  })

  it('recusa fonte que herda a url do protótipo', () => {
    const source = Object.create({ kind: 'hls', url: 'https://sa-east-1.cdn-exemplo.net/a.m3u8' }) as object
    expect(parseExtMessage({ ...play(), source }, manifest)).toBeNull()
  })
})

describe('origem da extensão', () => {
  it('monta a origem do subdomínio com o esquema e a base do servidor', () => {
    expect(extensionOrigin('lczfxd2q74zxknb5', { base: 'santamagia.com', scheme: 'https' })).toBe('https://lczfxd2q74zxknb5.santamagia.com')
    expect(extensionOrigin('lczfxd2q74zxknb5', { base: 'localhost:8787', scheme: 'http' })).toBe('http://lczfxd2q74zxknb5.localhost:8787')
  })
})

describe('url de mídia de uma extensão', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('nunca aponta para o próprio juntos, mesmo que o manifesto o declare', () => {
    vi.stubGlobal('location', new URL('https://juntos.example/r/abc'))

    expect(urlAllowed('https://juntos.example/api/account', ['juntos.example', 'media.example'])).toBe(false)
    expect(urlAllowed('https://media.example/a.m3u8', ['juntos.example', 'media.example'])).toBe(true)
  })

  it.each([
    ['blob:', 'blob:https://media.example/1b2c'],
    ['data:', 'data:video/mp4;base64,AAAA'],
    ['javascript:', 'javascript:alert(1)//media.example'],
    ['IP em hex', 'https://0x7f000001/a.m3u8'],
    ['IPv6', 'https://[::1]/a.m3u8'],
    ['barra invertida', 'https://evil.example\\@media.example/a.m3u8'],
  ])('recusa %s', (_, url) => {
    expect(urlAllowed(url, ['media.example'])).toBe(false)
  })
})

describe('payloads forjados', () => {
  const generic: ExtensionManifest = { ...manifest, hosts: { connect: [], images: [], media: ['media.example'] } }
  const ok = { juntos: 1, type: 'play', title: 'x', ref: '1', source: { kind: 'hls', url: 'https://media.example/a.m3u8' } }

  it.each([
    ['__proto__ próprio trazendo a fonte', JSON.parse('{"juntos":1,"type":"play","title":"x","ref":"1","__proto__":{"source":{"kind":"hls","url":"https://media.example/a.m3u8"}}}')],
    ['título número', { ...ok, title: 7 }],
    ['ref número', { ...ok, ref: 15228 }],
    ['fonte em array', { ...ok, source: ['hls', 'https://media.example/a.m3u8'] }],
    ['1 MB de título', { ...ok, title: 'a'.repeat(1 << 20) }],
    ['juntos como string', { ...ok, juntos: '1' }],
  ])('recusa %s', (_, message) => {
    expect(parseExtMessage(message, generic)).toBeNull()
  })

  it('o HTML no título passa como texto, sem virar outra coisa', () => {
    const title = '<img src=x onerror=alert(1)>'
    expect(parseExtMessage({ ...ok, title }, generic)).toMatchObject({ title })
  })
})
