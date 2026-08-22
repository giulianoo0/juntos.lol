import { describe, expect, it, vi } from 'vitest'
import { resolveStreams } from './resolve'
import type { InstalledPlugin } from './store'

const plugin = (id: string, enabled = true): InstalledPlugin => ({
  id,
  manifest: { id, name: id.toUpperCase(), version: '1', hosts: ['a.com'], updateUrl: null },
  source: '',
  sha256: '',
  origin: { kind: 'file', fileName: `${id}.js`, updateUrl: null },
  approvedHosts: ['a.com'],
  enabled,
  pendingUpdate: null,
  installedAt: 1,
})

const target = { type: 'movie' as const, id: 'tt0111161' }

// What a plugin returns is the bare array; the wrapping into `{ streams }`
// that parseStreams wants happens inside resolveStreams.
const torrent = (hash: string) => [{ name: 'X\n1080p', title: 'R', infoHash: hash }]

describe('resolveStreams', () => {
  it('reports that nothing is installed, which is a different problem from finding nothing', async () => {
    await expect(resolveStreams(target, { load: async () => [] })).resolves.toEqual({ kind: 'no-plugins' })
  })

  it('reports no plugins when every installed one is switched off', async () => {
    await expect(resolveStreams(target, { load: async () => [plugin('a', false)] }))
      .resolves.toEqual({ kind: 'no-plugins' })
  })

  it('reports an empty list when the plugins ran and found nothing', async () => {
    const result = await resolveStreams(target, { load: async () => [plugin('a')], run: async () => [] })
    expect(result).toEqual({ kind: 'streams', streams: [], failed: [] })
  })

  it('names the plugins that broke, which is not the same as finding nothing', async () => {
    const result = await resolveStreams(target, {
      load: async () => [plugin('a'), plugin('b')],
      run: async () => { throw new Error('timeout') },
    })
    if (result.kind !== 'streams') throw new Error('expected streams')
    expect(result.streams).toEqual([])
    expect(result.failed).toEqual(['A', 'B'])
  })

  it('joins what two plugins found and marks the provenance of each', async () => {
    const result = await resolveStreams(target, {
      load: async () => [plugin('a'), plugin('b')],
      run: async (installed) => torrent(installed.id === 'a' ? 'a'.repeat(40) : 'b'.repeat(40)),
    })
    if (result.kind !== 'streams') throw new Error('expected streams')
    expect(result.streams).toHaveLength(2)
    expect(result.streams.map((stream) => stream.pluginId).sort()).toEqual(['a', 'b'])
    expect(result.streams.map((stream) => stream.pluginName).sort()).toEqual(['A', 'B'])
  })

  it('survives one plugin throwing and keeps what the other found', async () => {
    const result = await resolveStreams(target, {
      load: async () => [plugin('good'), plugin('bad')],
      run: async (installed) => {
        if (installed.id === 'bad') throw new Error('boom')
        return torrent('a'.repeat(40))
      },
    })
    if (result.kind !== 'streams') throw new Error('expected streams')
    expect(result.streams).toHaveLength(1)
    expect(result.streams[0].pluginId).toBe('good')
    expect(result.failed).toEqual(['BAD'])
  })

  it('runs only the plugins that are switched on', async () => {
    const run = vi.fn(async () => torrent('a'.repeat(40)))
    await resolveStreams(target, { load: async () => [plugin('on'), plugin('off', false)], run })
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs each plugin against its approved hosts, not the ones its manifest now claims', async () => {
    // A held update leaves manifest.hosts wider than approvedHosts. Running
    // against the manifest would grant the capability the hold exists to
    // withhold.
    const held = {
      ...plugin('a'),
      manifest: { id: 'a', name: 'A', version: '1', hosts: ['a.com', 'evil.com'], updateUrl: null },
    }
    const seen: string[][] = []
    await resolveStreams(target, {
      load: async () => [held],
      run: async (installed) => { seen.push(installed.approvedHosts); return [] },
    })
    expect(seen).toEqual([['a.com']])
  })
})
