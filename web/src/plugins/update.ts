import { canonicalRepoUrl, fetchGitPlugin, readManifestFromSource, type InstallDeps } from './install'
import { listPlugins, putPlugin, sha256Hex, type InstalledPlugin } from './store'
import type { PluginManifest } from './manifest'

export interface UpdateDeps extends InstallDeps {
  fetchGit?: (repoUrl: string, deps?: InstallDeps) => Promise<{ source: string; commit: string }>
  save?: (plugin: InstalledPlugin) => Promise<void>
}

export type UpdateOutcome =
  | { kind: 'unchanged' }
  | { kind: 'applied'; version: string }
  | { kind: 'held'; newHosts: string[] }
  | { kind: 'refused'; reason: 'origin-changed' }
  | { kind: 'failed' }

export function updateUrlOf(plugin: InstalledPlugin): string | null {
  return plugin.origin.updateUrl
}

/** Whether two written addresses name the same GitHub repository. */
function sameOrigin(declared: string, locked: string): boolean {
  const home = canonicalRepoUrl(locked)
  try {
    return canonicalRepoUrl(declared) === home
  } catch {
    return false
  }
}

/** Hosts a new manifest wants that nobody has agreed to. */
function widenedHosts(manifest: PluginManifest, approved: string[]): string[] {
  return manifest.hosts.filter((host) => !approved.includes(host))
}

/**
 * Checks one plugin against its locked origin and applies what it finds. It
 * never follows a new `updateUrl` and never widens `approvedHosts` on its own:
 * a version asking for more capability is held instead.
 */
export async function updatePlugin(plugin: InstalledPlugin, deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const address = updateUrlOf(plugin)
  if (!address) return { kind: 'unchanged' }

  const fetchGit = deps.fetchGit ?? fetchGitPlugin
  const readManifest = deps.readManifest ?? readManifestFromSource
  const save = deps.save ?? putPlugin

  try {
    const { source, commit } = await fetchGit(address, deps)
    const sha256 = await sha256Hex(source)
    if (sha256 === plugin.sha256) {
      if (plugin.origin.kind === 'git' && commit !== '' && commit !== plugin.origin.commit) {
        await save({ ...plugin, origin: { ...plugin.origin, commit } })
      }
      return { kind: 'unchanged' }
    }

    const manifest = await readManifest(source)
    if (manifest.updateUrl !== null && !sameOrigin(manifest.updateUrl, address)) {
      return { kind: 'refused', reason: 'origin-changed' }
    }

    const newHosts = widenedHosts(manifest, plugin.approvedHosts)
    if (newHosts.length > 0) {
      await save({ ...plugin, pendingUpdate: { source, sha256, manifest, commit, newHosts } })
      return { kind: 'held', newHosts }
    }

    await save({
      ...plugin,
      manifest,
      source,
      sha256,
      approvedHosts: plugin.approvedHosts.filter((host) => manifest.hosts.includes(host)),
      origin: plugin.origin.kind === 'git' ? { ...plugin.origin, commit } : plugin.origin,
      pendingUpdate: null,
    })
    return { kind: 'applied', version: manifest.version }
  } catch {
    return { kind: 'failed' }
  }
}

/** Applies a held update, and only then widens what the plugin may reach. */
export async function approvePendingUpdate(
  plugin: InstalledPlugin,
  deps: Pick<UpdateDeps, 'save'> = {},
): Promise<InstalledPlugin> {
  const pending = plugin.pendingUpdate
  if (!pending) return plugin
  const applied: InstalledPlugin = {
    ...plugin,
    manifest: pending.manifest,
    source: pending.source,
    sha256: pending.sha256,
    origin: plugin.origin.kind === 'git' ? { ...plugin.origin, commit: pending.commit } : plugin.origin,
    approvedHosts: [...pending.manifest.hosts],
    pendingUpdate: null,
  }
  await (deps.save ?? putPlugin)(applied)
  return applied
}

/** Checks everything installed, once. Never rejects: this runs on page load. */
export async function updateAll(deps: UpdateDeps = {}): Promise<Record<string, UpdateOutcome>> {
  const plugins = await listPlugins()
  const entries = await Promise.all(plugins.map(async (plugin): Promise<[string, UpdateOutcome]> => {
    try {
      return [plugin.id, await updatePlugin(plugin, deps)]
    } catch {
      return [plugin.id, { kind: 'failed' }]
    }
  }))
  return Object.fromEntries(entries)
}
