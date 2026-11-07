import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetInstalled, freshInstalled, installedExtension, listInstalled, saveInstalled, updateFor, type InstalledExtension } from './installed'
import type { ExtensionManifest } from './protocol'

const manifest = (media: string[] = ['*.cdn.cool.tv'], version = '1.0.0'): ExtensionManifest => ({
  id: 'cool', name: 'Cool', version, protocol: 1, entry: 'index.html',
  hosts: { connect: ['api.cool.tv'], images: ['img.cool.tv'], media },
})

const record = (extra: Partial<InstalledExtension> = {}): InstalledExtension => ({
  id: 'cool', sub: 'abcdefghijklmnop', version: 'a'.repeat(40), manifest: manifest(), ...extra,
})

beforeEach(() => { localStorage.clear() })

describe('extensões instaladas neste aparelho', () => {
  it('guarda id, sub, versão aprovada e manifesto', () => {
    saveInstalled(record())

    expect(installedExtension('cool')).toEqual(record())
    expect(installedExtension('other')).toBeNull()
  })

  it('começa sem nada instalado', () => {
    expect(listInstalled()).toEqual([])
  })

  it('lista as instaladas pelo nome', () => {
    saveInstalled(record({ id: 'zeta', manifest: { ...manifest(), id: 'zeta', name: 'Zeta' } }))
    saveInstalled(record())

    expect(listInstalled().map((entry) => entry.manifest.name)).toEqual(['Cool', 'Zeta'])
  })

  it('esquece uma extensão', () => {
    saveInstalled(record())

    forgetInstalled('cool')

    expect(installedExtension('cool')).toBeNull()
  })

  it('trata armazenamento corrompido como nada instalado', () => {
    localStorage.setItem('ss.extensions', '{"cool": {"id": 3}}')

    expect(installedExtension('cool')).toBeNull()
  })

  it('não muda nada quando a versão é a aprovada', () => {
    expect(updateFor(record(), { version: 'a'.repeat(40), manifest: manifest() })).toEqual({ kind: 'current' })
  })

  it('atualiza sem perguntar quando os hosts são os mesmos', () => {
    const next = { version: 'b'.repeat(40), manifest: manifest(['*.cdn.cool.tv'], '1.1.0') }

    expect(updateFor(record(), next)).toEqual({ kind: 'silent', ...next })
  })

  it('pede aprovação quando a versão nova alcança hosts novos', () => {
    const next = { version: 'b'.repeat(40), manifest: manifest(['*.cdn.cool.tv', 'evil.com']) }

    expect(updateFor(record(), next)).toEqual({ kind: 'approve', ...next })
  })

  it('pede aprovação para o que nunca foi instalado', () => {
    const next = { version: 'b'.repeat(40), manifest: manifest() }

    expect(updateFor(null, next)).toEqual({ kind: 'approve', ...next })
  })
})

describe('freshInstalled', () => {
  const NEW = 'b'.repeat(40)
  afterEach(() => { vi.unstubAllGlobals() })

  function serve(next: ExtensionManifest, sha = NEW) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/extensions/cool') return Response.json({ id: 'cool', name: 'Cool', sub: 'abcdefghijklmnop', source: 'github:dono/cool' })
      if (url === '/api/extensions/cool/latest') return Response.json({ sha })
      if (url === `https://raw.githubusercontent.com/dono/cool/${sha}/juntos.json`) return Response.json(next)
      return new Response(null, { status: 404 })
    }))
  }

  it('fica com a instalada quando o sha é o mesmo', async () => {
    serve(manifest(), 'a'.repeat(40))
    expect(await freshInstalled(record())).toEqual(record())
  })

  it('passa para o sha novo e guarda quando os hosts são os mesmos', async () => {
    serve(manifest(['*.cdn.cool.tv'], '1.1.0'))
    saveInstalled(record())
    const fresh = await freshInstalled(record())
    expect(fresh?.version).toBe(NEW)
    expect(installedExtension('cool')?.version).toBe(NEW)
  })

  it('devolve null e não guarda quando o sha novo alcança hosts novos', async () => {
    serve(manifest(['*.outra.tv']))
    saveInstalled(record())
    expect(await freshInstalled(record())).toBeNull()
    expect(installedExtension('cool')?.version).toBe('a'.repeat(40))
  })
})
