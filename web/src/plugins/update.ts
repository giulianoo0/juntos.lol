import { fetchGitPlugin, readManifestFromSource, type InstallDeps } from './install'
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

/** Where this plugin updates from, or null for a file with no home. */
export function updateUrlOf(plugin: InstalledPlugin): string | null {
  return plugin.origin.updateUrl
}

/** Hosts a new manifest wants that nobody has agreed to. */
function widenedHosts(manifest: PluginManifest, approved: string[]): string[] {
  return manifest.hosts.filter((host) => !approved.includes(host))
}

/**
 * Checks one plugin against its locked origin and applies what it finds.
 *
 * Two things this deliberately does not do. It does not follow a new
 * `updateUrl`: the address was accepted once, by a person, and a plugin does
 * not get to redirect its own update channel — the `known_hosts` argument. And
 * it does not widen `approvedHosts` on its own: code changing is expected,
 * capability changing is not, so a version that asks for more waits.
 */
export async function updatePlugin(plugin: InstalledPlugin, deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const address = updateUrlOf(plugin)
  if (!address) return { kind: 'unchanged' }

  const fetchGit = deps.fetchGit ?? fetchGitPlugin
  const readManifest = deps.readManifest ?? readManifestFromSource
  const save = deps.save ?? putPlugin

  try {
    const { source, commit } = await fetchGit(address, deps)
    const currentCommit = plugin.origin.kind === 'git' ? plugin.origin.commit : ''
    // A repository that reports no commit falls back to comparing the code.
    if (commit !== '' && commit === currentCommit) return { kind: 'unchanged' }
    const sha256 = await sha256Hex(source)
    if (sha256 === plugin.sha256) return { kind: 'unchanged' }

    const manifest = await readManifest(source)
    // Dropping the field is not a redirect: the locked origin still governs.
    if (manifest.updateUrl !== null && manifest.updateUrl !== address) {
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
      origin: plugin.origin.kind === 'git' ? { ...plugin.origin, commit } : plugin.origin,
      pendingUpdate: null,
    })
    return { kind: 'applied', version: manifest.version }
  } catch {
    // Offline, rate limited, or a new version whose manifest will not parse.
    // The installed version stays exactly as it is, and nothing is said: a
    // failed network call is not an event worth interrupting anyone over.
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

/**
 * Checks everything installed, once. Never rejects: this runs on page load,
 * and one unreachable repository must not stop the others from updating or
 * take the site down with it.
 */
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
