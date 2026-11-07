import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionError, fetchManifest, findExtension, parseRepo, registerExtension, resolveVersion } from './registry'

const manifest = {
  id: 'cool', name: 'Cool', version: '1.0.0', protocol: 1, entry: 'index.html',
  hosts: { connect: ['api.cool.tv'], images: [], media: ['*.cool.tv'] },
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals() })

describe('registro de extensões', () => {
  it('acha uma extensão do registro pelo id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { id: 'cool', name: 'Cool', sub: 'abcdefghijklmnop', source: 'github:dono/cool', icon: 'icon.png' })))

    expect(await findExtension(' Cool ')).toEqual({ id: 'cool', name: 'Cool', sub: 'abcdefghijklmnop', source: 'github:dono/cool', icon: 'icon.png' })
    expect(fetch).toHaveBeenCalledWith('/api/extensions/cool', expect.anything())
  })

  it.each([
    ['um id que não existe', 404, {}, 'not_found'],
    ['uma resposta malformada', 200, { id: 'cool', name: { html: '<b>' }, sub: 'x', source: 'github:a/b' }, 'failed'],
    ['outra extensão no lugar', 200, { id: 'evil', name: 'Evil', sub: 'abcdefghijklmnop', source: 'github:a/b' }, 'failed'],
    ['uma fonte que não é do GitHub', 200, { id: 'cool', name: 'Cool', sub: 'abcdefghijklmnop', source: 'juntos:cool' }, 'failed'],
  ])('recusa %s', async (_, status, body, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(status, body)))

    const failure = await findExtension('cool').catch((error: unknown) => error)

    expect((failure as ExtensionError).code).toBe(code)
  })

  it('não pergunta nada por um id que não pode existir', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const failure = await findExtension('../x').catch((error: unknown) => error)

    expect((failure as ExtensionError).code).toBe('bad_id')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('registra um repositório e devolve o manifesto validado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(201, { id: 'cool', sub: 'abcdefghijklmnop', sha: 'a'.repeat(40), manifest })))

    expect(await registerExtension('dono/cool')).toEqual({ id: 'cool', sub: 'abcdefghijklmnop', version: 'a'.repeat(40), manifest })
    expect(fetch).toHaveBeenCalledWith('/api/extensions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ repo: 'dono/cool' }) }))
  })

  it.each([
    ['protocolo 2', { ...manifest, protocol: 2 }],
    ['entry que sobe de pasta', { ...manifest, entry: '../index.html' }],
    ['entry absoluto', { ...manifest, entry: 'https://evil.com/x.html' }],
    ['hosts que não são lista', { ...manifest, hosts: { connect: 'api.cool.tv', images: [], media: [] } }],
    ['host com esquema', { ...manifest, hosts: { connect: [], images: [], media: ['https://cool.tv'] } }],
  ])('recusa manifesto com %s mesmo vindo do servidor', async (_, bad) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(201, { id: 'cool', sub: 'abcdefghijklmnop', sha: 'a'.repeat(40), manifest: bad })))

    const failure = await registerExtension('dono/cool').catch((error: unknown) => error)

    expect((failure as ExtensionError).code).toBe('bad_manifest')
  })

  it('lê o manifesto da versão e confere que é da extensão pedida', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, manifest)))

    expect(await fetchManifest('/extensions/cool/juntos.json', 'cool')).toEqual(manifest)
    await expect(fetchManifest('/extensions/cool/juntos.json', 'outra')).rejects.toBeInstanceOf(ExtensionError)
  })

  it.each([
    [409, { error: 'id_taken' }, 'id_taken'],
    [422, { error: 'bad_manifest', detail: 'protocol' }, 'bad_manifest'],
    [422, { error: 'not_open_source' }, 'not_open_source'],
    [404, { error: 'repo_not_found' }, 'not_found'],
    [401, { error: 'account_required' }, 'not_allowed'],
    [403, { error: 'publisher_only' }, 'not_allowed'],
    [400, { error: 'bad_repo' }, 'bad_repo'],
    [429, {}, 'busy'],
    [500, {}, 'failed'],
  ])('traduz a recusa %i do registro', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(status, body)))

    const failure = await registerExtension('dono/cool').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ExtensionError)
    expect((failure as ExtensionError).code).toBe(code)
  })

  it.each([
    ['dono/repo', 'dono/repo'],
    ['  dono/repo  ', 'dono/repo'],
    ['https://github.com/dono/repo', 'dono/repo'],
    ['github.com/dono/repo.git', 'dono/repo'],
    ['dono', null],
    ['dono/repo/tree/main', null],
    ['../etc/passwd', null],
  ])('entende %j como repositório', (raw, repo) => {
    expect(parseRepo(raw)).toBe(repo)
  })

  it('a versão de uma extensão do GitHub é o sha que o servidor conhece', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { sha: 'b'.repeat(40) })))

    expect(await resolveVersion({ id: 'cool', source: 'github:dono/cool' })).toEqual({
      version: 'b'.repeat(40),
      manifestUrl: `https://raw.githubusercontent.com/dono/cool/${'b'.repeat(40)}/juntos.json`,
    })
    expect(fetch).toHaveBeenCalledWith('/api/extensions/cool/latest', expect.anything())
  })

  it('lê o manifesto da origem configurada para os repositórios', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { sha: 'b'.repeat(40) })))

    expect((await resolveVersion({ id: 'cool', source: 'github:dono/cool' }, 'http://127.0.0.1:8797')).manifestUrl)
      .toBe(`http://127.0.0.1:8797/dono/cool/${'b'.repeat(40)}/juntos.json`)
  })

  it('recusa um sha que não é de 40 hex', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { sha: '../main' })))

    await expect(resolveVersion({ id: 'cool', source: 'github:dono/cool' })).rejects.toBeInstanceOf(ExtensionError)
  })
})
