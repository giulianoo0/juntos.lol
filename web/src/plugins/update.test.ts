import { beforeEach, describe, expect, it, vi } from 'vitest'
import { approvePendingUpdate, updateAll, updatePlugin, updateUrlOf } from './update'
import { deletePlugin, listPlugins, putPlugin, sha256Hex, type InstalledPlugin } from './store'

// The real digest of the installed source, because updatePlugin compares the
// code rather than trusting the commit — a fixture with a made-up hash would
// make "same code" unreachable and hide the branch.
const OLD_SHA = await sha256Hex('old')

const installed: InstalledPlugin = {
  id: 'torrentio',
  manifest: { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['a.com'], updateUrl: 'https://github.com/u/r' },
  source: 'old',
  sha256: OLD_SHA,
  origin: { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'aaa' },
  approvedHosts: ['a.com'],
  enabled: true,
  pendingUpdate: null,
  installedAt: 1,
}

const manifestOf = (over: Partial<InstalledPlugin['manifest']>) => ({ ...installed.manifest, ...over })

function deps(over: {
  source?: string; commit?: string; manifest?: InstalledPlugin['manifest']
}, saved: InstalledPlugin[] = []) {
  return {
    fetchGit: vi.fn().mockResolvedValue({ source: over.source ?? 'new', commit: over.commit ?? 'bbb' }),
    readManifest: () => Promise.resolve(over.manifest ?? manifestOf({ version: '1.1.0' })),
    save: async (plugin: InstalledPlugin) => { saved.push(plugin) },
  }
}

describe('updateUrlOf', () => {
  it('reads the address from a git origin', () => {
    expect(updateUrlOf(installed)).toBe('https://github.com/u/r')
  })

  it('reads the address a dropped file declared', () => {
    const file = { ...installed, origin: { kind: 'file' as const, fileName: 'p.js', updateUrl: 'https://github.com/u/r' } }
    expect(updateUrlOf(file)).toBe('https://github.com/u/r')
  })

  it('is null for a file with no home', () => {
    expect(updateUrlOf({ ...installed, origin: { kind: 'file', fileName: 'p.js', updateUrl: null } })).toBeNull()
  })
})

describe('updatePlugin', () => {
  it('does nothing when the code has not changed', async () => {
    const saved: InstalledPlugin[] = []
    const d = deps({ source: 'old', commit: 'aaa' }, saved)
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'unchanged' })
    expect(saved).toHaveLength(0)
  })

  it('applies a new version whose hosts stayed within what was approved', async () => {
    const saved: InstalledPlugin[] = []
    await expect(updatePlugin(installed, deps({}, saved))).resolves.toEqual({ kind: 'applied', version: '1.1.0' })
    expect(saved[0].source).toBe('new')
    expect(saved[0].manifest.version).toBe('1.1.0')
    expect(saved[0].origin).toEqual({ kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'bbb' })
  })

  it('holds an update that wants a host nobody approved', async () => {
    const saved: InstalledPlugin[] = []
    // approvedHosts and manifest.hosts deliberately differ, so a version that
    // compared the manifest against itself would not pass this.
    const d = deps({ manifest: manifestOf({ hosts: ['a.com', 'b.com', 'tracker.evil.com'] }) }, saved)
    await expect(updatePlugin({ ...installed, approvedHosts: ['a.com', 'b.com'] }, d))
      .resolves.toEqual({ kind: 'held', newHosts: ['tracker.evil.com'] })
    expect(saved[0].source).toBe('old')
    expect(saved[0].pendingUpdate?.newHosts).toEqual(['tracker.evil.com'])
    expect(saved[0].approvedHosts).toEqual(['a.com', 'b.com'])
  })

  it('does not hold an update that dropped a host, and stops approving it', async () => {
    // Two approved, one declared: capability shrank, and shrinking asks
    // nothing of anybody — but it does have to actually take effect, because
    // resolveStreams runs against approvedHosts and not against the manifest.
    const saved: InstalledPlugin[] = []
    const wider = { ...installed, approvedHosts: ['a.com', 'b.com'] }
    const d = deps({ manifest: manifestOf({ hosts: ['a.com'], version: '2.0.0' }) }, saved)
    await expect(updatePlugin(wider, d)).resolves.toEqual({ kind: 'applied', version: '2.0.0' })
    expect(saved[0].approvedHosts).toEqual(['a.com'])
  })

  it('accepts an update whose manifest spells the same repository differently', async () => {
    // GitHub does not distinguish case, and parseManifest keeps the path. A
    // raw string comparison here would read this as a redirected origin and
    // refuse a legitimate update for ever.
    const d = deps({ manifest: manifestOf({ updateUrl: 'https://GitHub.com/U/R.git/', version: '1.3.0' }) })
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'applied', version: '1.3.0' })
  })

  it('looks at the code even when the commit has not moved', async () => {
    // fetchGitPlugin reads the file and the commit separately; a push between
    // the two pairs old code with a new sha. Trusting the commit would leave
    // that version invisible for ever.
    const saved: InstalledPlugin[] = []
    const d = deps({ commit: 'aaa', source: 'genuinely new', manifest: manifestOf({ version: '1.4.0' }) }, saved)
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'applied', version: '1.4.0' })
    expect(saved[0].source).toBe('genuinely new')
  })

  it('records a moved commit even when the code is identical', async () => {
    const saved: InstalledPlugin[] = []
    const d = deps({ source: 'old', commit: 'ccc' }, saved)
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'unchanged' })
    expect(saved[0].origin).toEqual({ kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'ccc' })
  })

  it('refuses an update that redirects its own update address', async () => {
    const d = deps({ manifest: manifestOf({ updateUrl: 'https://github.com/someone/else' }) })
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'refused', reason: 'origin-changed' })
  })

  it('accepts an update whose manifest simply stopped declaring an address', async () => {
    // Dropping updateUrl is not a redirect. The locked origin still governs.
    const d = deps({ manifest: manifestOf({ updateUrl: null, version: '1.2.0' }) })
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'applied', version: '1.2.0' })
  })

  it('reports failure without touching the installed version', async () => {
    const saved: InstalledPlugin[] = []
    const d = { ...deps({}, saved), fetchGit: vi.fn().mockRejectedValue(new Error('offline')) }
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'failed' })
    expect(saved).toHaveLength(0)
  })

  it('reports failure when the new source has a manifest that will not parse', async () => {
    const saved: InstalledPlugin[] = []
    const d = { ...deps({}, saved), readManifest: () => Promise.reject(new Error('plugin manifest: not an object')) }
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'failed' })
    expect(saved).toHaveLength(0)
  })

  it('is unchanged for a plugin with nowhere to update from', async () => {
    const orphan = { ...installed, origin: { kind: 'file' as const, fileName: 'p.js', updateUrl: null } }
    await expect(updatePlugin(orphan, deps({}))).resolves.toEqual({ kind: 'unchanged' })
  })
})

describe('approvePendingUpdate', () => {
  it('applies the held version and widens the approved hosts', async () => {
    const held: InstalledPlugin = {
      ...installed,
      pendingUpdate: {
        source: 'new', sha256: 'new-hash',
        manifest: manifestOf({ version: '2.0.0', hosts: ['a.com', 'b.com'] }),
        commit: 'bbb', newHosts: ['b.com'],
      },
    }
    const saved: InstalledPlugin[] = []
    const applied = await approvePendingUpdate(held, { save: async (p) => { saved.push(p) } })
    expect(applied.source).toBe('new')
    expect(applied.approvedHosts).toEqual(['a.com', 'b.com'])
    expect(applied.pendingUpdate).toBeNull()
    expect(saved).toHaveLength(1)
  })

  it('leaves a plugin with nothing pending exactly as it was', async () => {
    const saved: InstalledPlugin[] = []
    const same = await approvePendingUpdate(installed, { save: async (p) => { saved.push(p) } })
    expect(same).toEqual(installed)
    expect(saved).toHaveLength(0)
  })
})

describe('updateAll', () => {
  beforeEach(async () => {
    for (const plugin of await listPlugins()) await deletePlugin(plugin.id)
  })

  it('checks every plugin and never rejects, whatever any single one does', async () => {
    await putPlugin({ ...installed, id: 'good' })
    await putPlugin({ ...installed, id: 'bad' })
    const outcomes = await updateAll({ fetchGit: () => Promise.reject(new Error('offline')) })
    expect(Object.keys(outcomes).sort()).toEqual(['bad', 'good'])
    expect(Object.values(outcomes).every((outcome) => outcome.kind === 'failed')).toBe(true)
  })

  it('leaves the installed version in place when the network is gone', async () => {
    await putPlugin(installed)
    await updateAll({ fetchGit: () => Promise.reject(new Error('offline')) })
    const [after] = await listPlugins()
    expect(after.source).toBe('old')
    expect(after.manifest.version).toBe('1.0.0')
  })
})
