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

/** Where this plugin updates from, or null for a file with no home. */
export function updateUrlOf(plugin: InstalledPlugin): string | null {
  return plugin.origin.updateUrl
}

/**
 * Whether two written addresses name the same repository.
 *
 * The locked address is ours, so it is canonicalised outside the try: if that
 * throws, the registry is what is broken, and the caller should report a
 * failure rather than accuse the plugin of redirecting itself.
 */
function sameOrigin(declared: string, locked: string): boolean {
  const home = canonicalRepoUrl(locked)
  try {
    return canonicalRepoUrl(declared) === home
  } catch {
    // A declared address that is not a repository at all is not this one.
    return false
  }
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
    // The code decides, never the commit. `fetchGitPlugin` reads the file and
    // the commit in two separate requests, and a push landing between them
    // pairs the old code with the new sha — a shortcut on the commit would
    // then call it unchanged and never look at the new version again.
    const sha256 = await sha256Hex(source)
    if (sha256 === plugin.sha256) {
      // Same code, moved commit: record the commit so the next check has an
      // accurate baseline, but nothing else changed.
      if (plugin.origin.kind === 'git' && commit !== '' && commit !== plugin.origin.commit) {
        await save({ ...plugin, origin: { ...plugin.origin, commit } })
      }
      return { kind: 'unchanged' }
    }

    const manifest = await readManifest(source)
    // Compared canonically on both sides. `parseManifest` normalises by a
    // different rule — it keeps the path and the case — and GitHub does not
    // distinguish case, so a raw string comparison would read `User/Repo` as a
    // redirected origin and refuse a legitimate update for ever.
    // Dropping the field is not a redirect: the locked origin still governs.
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
      // Capability the new version stopped asking for stops applying.
      // Narrowing asks nobody's permission, and leaving a host approved after
      // the plugin quit declaring it is capability with no owner — `resolve`
      // runs against this list, not against the manifest.
      approvedHosts: plugin.approvedHosts.filter((host) => manifest.hosts.includes(host)),
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
