import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsPanel } from './ExtensionsPanel'
import { installedExtension, saveInstalled } from './installed'
import type { ExtensionManifest } from './protocol'

const exemplo: ExtensionManifest = {
  id: 'exemplo', name: 'Exemplo', version: '1.0.0', protocol: 1, entry: 'index.html',
  hosts: { connect: ['api.exemplo.com'], images: ['img.exemplo.com'], media: ['*.cdn.exemplo.com'] },
}
const cool: ExtensionManifest = {
  id: 'cool', name: 'Cool', version: '2.0.0', protocol: 1, entry: 'app/index.html',
  hosts: { connect: ['api.cool.tv'], images: [], media: ['media.cool.tv'] },
}
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const EXEMPLO = { id: 'exemplo', name: 'Exemplo', sub: 'lczfxd2q74zxknb5', source: 'github:dono/exemplo' }
const COOL = { id: 'cool', name: 'Cool', sub: 'abcdefghijklmnop', source: 'github:dono/cool' }

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function serve(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    const route = routes[key]
    return route ? route() : reply(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The registry knows exemplo at SHA_A. */
const exemploRoutes = {
  'GET /api/extensions/exemplo': () => reply(200, EXEMPLO),
  'GET /api/extensions/exemplo/latest': () => reply(200, { sha: SHA_A }),
  [`GET https://raw.githubusercontent.com/dono/exemplo/${SHA_A}/juntos.json`]: () => reply(200, exemplo),
}

function mount({ onPlay = vi.fn(), canPublish = false } = {}) {
  render(<ExtensionsPanel open canPlay canPublish={canPublish} place={{ base: 'santamagia.com', scheme: 'https' }} onPlay={onPlay} onClose={vi.fn()} onToast={vi.fn()} />)
  return { onPlay }
}

const frame = () => document.querySelector('iframe')

async function addByID(id: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Adicionar' }))
  fireEvent.change(screen.getByLabelText('ID da extensão'), { target: { value: id } })
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('painel de extensões', () => {
  it('começa vazio, sem trazer o catálogo do registro', async () => {
    const fetchMock = serve({})
    mount()

    expect(await screen.findByText('Nenhuma extensão.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Extensões' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('instala pelo id mostrando nome e hosts antes de confirmar', async () => {
    serve(exemploRoutes)
    mount()

    await addByID('exemplo')

    expect(await screen.findByRole('heading', { name: 'Exemplo' })).toBeInTheDocument()
    const hosts = screen.getByRole('list', { name: 'Vai acessar' })
    expect(within(hosts).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['api.exemplo.com', 'img.exemplo.com', '*.cdn.exemplo.com'])
    expect(frame()).toBeNull()
    expect(installedExtension('exemplo')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))

    await waitFor(() => expect(frame()).toHaveAttribute('src', `https://lczfxd2q74zxknb5.santamagia.com/@${SHA_A}/index.html`))
    expect(installedExtension('exemplo')).toMatchObject({ sub: 'lczfxd2q74zxknb5', version: SHA_A })
  })

  it('diz quando nenhuma extensão tem esse id', async () => {
    serve({})
    mount()

    await addByID('nada')

    expect(await screen.findByRole('alert')).toHaveTextContent('Nenhuma extensão com esse ID')
  })

  it('lista as instaladas pelo nome e abre a que está em dia direto', async () => {
    saveInstalled({ id: 'exemplo', sub: 'lczfxd2q74zxknb5', version: SHA_A, manifest: exemplo })
    serve(exemploRoutes)
    mount()

    const list = await screen.findByRole('list', { name: 'Extensões' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Exemplo'])
    fireEvent.click(within(list).getByRole('button', { name: 'Exemplo' }))

    await waitFor(() => expect(frame()).toHaveAttribute('src', `https://lczfxd2q74zxknb5.santamagia.com/@${SHA_A}/index.html`))
  })

  it('pede aprovação de novo quando a versão nova alcança outros hosts', async () => {
    saveInstalled({ id: 'cool', sub: 'abcdefghijklmnop', version: SHA_A, manifest: cool })
    const next = { ...cool, hosts: { ...cool.hosts, media: ['media.cool.tv', 'cdn.other.tv'] } }
    serve({
      'GET /api/extensions/cool': () => reply(200, COOL),
      'GET /api/extensions/cool/latest': () => reply(200, { sha: SHA_B }),
      [`GET https://raw.githubusercontent.com/dono/cool/${SHA_B}/juntos.json`]: () => reply(200, next),
    })
    mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Cool' }))

    const hosts = await screen.findByRole('list', { name: 'Vai acessar' })
    expect(within(hosts).getByText('cdn.other.tv')).toBeInTheDocument()
    expect(frame()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))

    await waitFor(() => expect(frame()).toHaveAttribute('src', `https://abcdefghijklmnop.santamagia.com/@${SHA_B}/app/index.html`))
  })

  it('não oferece publicar a quem não pode', async () => {
    serve({})
    mount()

    expect(await screen.findByRole('button', { name: 'Adicionar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publicar extensão' })).not.toBeInTheDocument()
  })

  it('quem pode publica por dono/repo e confirma os hosts', async () => {
    const fetchMock = serve({
      'POST /api/extensions': () => reply(201, { id: 'cool', sub: 'abcdefghijklmnop', sha: SHA_A, manifest: cool }),
    })
    mount({ canPublish: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Publicar extensão' }))
    fireEvent.change(screen.getByLabelText('Repositório'), { target: { value: 'https://github.com/dono/cool' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))

    const hosts = await screen.findByRole('list', { name: 'Vai acessar' })
    expect(within(hosts).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['api.cool.tv', 'media.cool.tv'])
    expect(fetchMock).toHaveBeenCalledWith('/api/extensions', expect.objectContaining({ body: JSON.stringify({ repo: 'dono/cool' }) }))

    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))

    await waitFor(() => expect(frame()).toHaveAttribute('src', `https://abcdefghijklmnop.santamagia.com/@${SHA_A}/app/index.html`))
  })

  it.each([
    ['id_taken', 409, 'Esse id já é de outra extensão'],
    ['not_open_source', 422, 'O repositório precisa ser público e ter licença'],
    ['bad_manifest', 422, 'O juntos.json desse repositório não vale'],
  ])('diz por que o registro recusou a publicação (%s)', async (error, status, text) => {
    serve({ 'POST /api/extensions': () => reply(status, { error }) })
    mount({ canPublish: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Publicar extensão' }))
    fireEvent.change(screen.getByLabelText('Repositório'), { target: { value: 'dono/cool' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('entrega o play da extensão aberta', async () => {
    saveInstalled({ id: 'exemplo', sub: 'lczfxd2q74zxknb5', version: SHA_A, manifest: exemplo })
    serve(exemploRoutes)
    const { onPlay } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Exemplo' }))
    await waitFor(() => expect(frame()).toHaveAttribute('src'))
    const play = { juntos: 1, type: 'play', title: 'Episódio', ref: 'ep-1', source: { kind: 'hls', url: 'https://a.cdn.exemplo.com/a.m3u8' } }

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: play, origin: 'https://lczfxd2q74zxknb5.santamagia.com', source: frame()!.contentWindow }))
    })

    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'exemplo', sub: 'lczfxd2q74zxknb5' }), play)
  })
})

describe('código das extensões', () => {
  it('não injeta HTML em lugar nenhum', () => {
    const dir = join(__dirname)
    const files = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
    for (const name of files) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/)
    }
  })
})
