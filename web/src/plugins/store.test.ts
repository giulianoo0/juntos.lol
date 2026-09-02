import { beforeEach, describe, expect, it } from 'vitest'
import {
  deletePlugin, getPlugin, listPlugins, originId, originKey, putPlugin, sha256Hex,
  type InstalledPlugin,
} from './store'

const sample = (id: string, enabled = true): InstalledPlugin => ({
  id,
  manifest: { id, name: id, version: '1.0.0', hosts: ['a.com'], updateUrl: null },
  source: `export const manifest = {}; // ${id}`,
  sha256: 'deadbeef',
  origin: { kind: 'file', fileName: `${id}.js`, updateUrl: null },
  approvedHosts: ['a.com'],
  enabled,
  pendingUpdate: null,
  installedAt: 1,
})

describe('the plugin registry', () => {
  beforeEach(async () => {
    for (const plugin of await listPlugins()) await deletePlugin(plugin.id)
  })

  it('starts empty', async () => {
    expect(await listPlugins()).toEqual([])
  })

  it('stores and reads a plugin back whole', async () => {
    await putPlugin(sample('acme'))
    expect(await getPlugin('acme')).toEqual(sample('acme'))
  })

  it('replaces a plugin when the same record is put again', async () => {
    await putPlugin(sample('acme'))
    await putPlugin(sample('acme', false))
    expect(await listPlugins()).toHaveLength(1)
    expect((await getPlugin('acme'))?.enabled).toBe(false)
  })

  it('keeps two origins apart even when they claim the same manifest id', async () => {
    const mine = { kind: 'git' as const, updateUrl: 'https://github.com/me/ss-plugin-acme', commit: 'a' }
    const theirs = { kind: 'git' as const, updateUrl: 'https://github.com/someone/evil', commit: 'b' }
    expect(originKey(mine)).not.toBe(originKey(theirs))
    await putPlugin({ ...sample('x'), id: await originId(mine), origin: mine })
    await putPlugin({ ...sample('x'), id: await originId(theirs), origin: theirs })
    expect(await listPlugins()).toHaveLength(2)
  })

  it('removes a plugin', async () => {
    await putPlugin(sample('a'))
    await deletePlugin('a')
    expect(await getPlugin('a')).toBeNull()
  })

  it('answers null for a plugin that was never installed', async () => {
    expect(await getPlugin('ghost')).toBeNull()
  })
})

describe('originKey', () => {
  it('separates a file from a repository even when the names collide', () => {
    expect(originKey({ kind: 'file', fileName: 'x', updateUrl: null }))
      .not.toBe(originKey({ kind: 'git', updateUrl: 'x', commit: 'c' }))
  })

  it('ignores the commit, because a plugin that updated is the same plugin', () => {
    const at = (commit: string) => originKey({ kind: 'git', updateUrl: 'https://github.com/u/r', commit })
    expect(at('aaa')).toBe(at('bbb'))
  })

  it('ignores an updateUrl a file later learned about, so the id never moves', () => {
    expect(originKey({ kind: 'file', fileName: 'p.js', updateUrl: null }))
      .toBe(originKey({ kind: 'file', fileName: 'p.js', updateUrl: 'https://github.com/u/r' }))
  })
})

describe('sha256Hex', () => {
  it('hashes to a stable lowercase hex digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes text outside ascii the same way every time', async () => {
    expect(await sha256Hex('café')).toBe(await sha256Hex('café'))
    expect(await sha256Hex('café')).toHaveLength(64)
  })
})
