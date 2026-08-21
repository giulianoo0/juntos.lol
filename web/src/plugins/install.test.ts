import { describe, expect, it, vi } from 'vitest'
import { buildInstall, canonicalRepoUrl, fetchGitPlugin, gitSourceUrls } from './install'

const manifest = { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['torrentio.strem.fun'], updateUrl: null }
const readManifest = () => Promise.resolve(manifest)

describe('canonicalRepoUrl', () => {
  it('collapses every spelling of one repository into one', () => {
    // The registry key is a hash of this, and an update is refused when it
    // does not match the manifest. A value that varies with how someone typed
    // it would refuse every legitimate update for ever.
    for (const written of [
      'https://github.com/user/repo',
      'https://github.com/user/repo/',
      'https://github.com/user/repo.git',
      'https://github.com/user/repo.git/',
      'https://GitHub.com/user/repo',
      'https://github.com./user/repo',
    ]) {
      expect(canonicalRepoUrl(written)).toBe('https://github.com/user/repo')
    }
  })

  it('drops anything beyond the repository itself', () => {
    expect(canonicalRepoUrl('https://github.com/user/repo/tree/main')).toBe('https://github.com/user/repo')
  })
})

describe('gitSourceUrls', () => {
  it('turns a github repo url into a raw file url and a commit endpoint', () => {
    expect(gitSourceUrls('https://github.com/user/repo')).toEqual({
      rawUrl: 'https://raw.githubusercontent.com/user/repo/HEAD/plugin.js',
      commitApi: 'https://api.github.com/repos/user/repo/commits/HEAD',
    })
  })

  it('tolerates a trailing slash and a .git suffix', () => {
    expect(gitSourceUrls('https://github.com/user/repo.git/').rawUrl)
      .toBe('https://raw.githubusercontent.com/user/repo/HEAD/plugin.js')
  })

  it('refuses anything that is not a github repository url', () => {
    expect(() => gitSourceUrls('https://example.com/user/repo')).toThrow(/github/)
    expect(() => gitSourceUrls('https://github.com/user')).toThrow(/repository/)
    expect(() => gitSourceUrls('http://github.com/user/repo')).toThrow(/https/)
    expect(() => gitSourceUrls('not a url')).toThrow(/URL/)
  })
})

describe('fetchGitPlugin', () => {
  it('reads the source and the commit sha', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.github.com')) return new Response(JSON.stringify({ sha: 'abc123' }), { status: 200 })
      return new Response('export const manifest = {}', { status: 200 })
    })
    await expect(fetchGitPlugin('https://github.com/user/repo', { fetch: fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ source: 'export const manifest = {}', commit: 'abc123' })
  })

  it('installs from a repository that will not report a commit', async () => {
    // Rate limited, or a repository the commits API will not answer for. The
    // source is in hand, which is what matters; it simply never reports an
    // update afterwards.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('api.github.com')
        ? new Response('rate limited', { status: 403 })
        : new Response('export const manifest = {}', { status: 200 })
    ))
    await expect(fetchGitPlugin('https://github.com/user/repo', { fetch: fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ source: 'export const manifest = {}', commit: '' })
  })

  it('fails when the repository has no plugin.js', async () => {
    const fetchMock = vi.fn(async () => new Response('Not Found', { status: 404 }))
    await expect(fetchGitPlugin('https://github.com/user/repo', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/plugin\.js/)
  })
})

describe('buildInstall', () => {
  it('locks the approved hosts to what the manifest asked for at install', async () => {
    const plugin = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, { readManifest })
    expect(plugin.approvedHosts).toEqual(['torrentio.strem.fun'])
    expect(plugin.enabled).toBe(true)
    expect(plugin.pendingUpdate).toBeNull()
    expect(plugin.sha256).toHaveLength(64)
  })

  it('keys the record by origin, not by the id the manifest claims', async () => {
    const asFile = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, { readManifest })
    const asRepo = await buildInstall('src', { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'c' }, { readManifest })
    expect(asFile.id).not.toBe(asRepo.id)
    expect(asFile.id).not.toBe(manifest.id)
    expect(asFile.manifest.id).toBe('torrentio')
  })

  it('gives one repository one id however its address was written', async () => {
    const at = (updateUrl: string) => buildInstall('src', { kind: 'git', updateUrl, commit: 'c' }, { readManifest })
    expect((await at('https://github.com/u/r')).id).toBe((await at('https://github.com/u/r/')).id)
  })

  it('carries a file manifest updateUrl into the origin, so a dropped file can still update', async () => {
    const withHome = { ...manifest, updateUrl: 'https://github.com/user/repo' }
    const plugin = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, {
      readManifest: () => Promise.resolve(withHome),
    })
    expect(plugin.origin).toEqual({ kind: 'file', fileName: 'p.js', updateUrl: 'https://github.com/user/repo' })
  })

  it('keeps a file id stable once it learns where it updates from', async () => {
    // buildInstall fills origin.updateUrl in from the manifest. If the id
    // moved with it, installing would produce one record and the first update
    // another, and the plugin would clone itself.
    const bare = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, { readManifest })
    const withHome = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, {
      readManifest: () => Promise.resolve({ ...manifest, updateUrl: 'https://github.com/user/repo' }),
    })
    expect(bare.id).toBe(withHome.id)
  })
})
