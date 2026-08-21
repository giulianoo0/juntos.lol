import { parseManifest, type PluginManifest } from './manifest'
import { runPlugin } from './runtime'
import { pageFetch, spawnManifestReader } from './spawn'
import { originId, sha256Hex, type InstalledPlugin, type PluginOrigin } from './store'

export interface InstallDeps {
  fetch?: typeof globalThis.fetch
  readManifest?: (source: string) => Promise<PluginManifest>
}

/** The file a plugin repository is expected to publish. */
const PLUGIN_FILE = 'plugin.js'

/** Importing a module and reading one object is not a fifteen-second job. */
const MANIFEST_TIMEOUT_MS = 5_000

/**
 * Reads what a module says about itself.
 *
 * Reading a manifest means running the module's top level, and that happens
 * in the worker, never here. Doing it in the page would hand the plugin
 * `localStorage`, the registry of every other installed plugin, and a
 * same-origin `/api` — and since updates run unattended on every page load
 * over code freshly pulled from a repository, a compromised plugin repo would
 * get all of that without a single click.
 *
 * `hosts: []` is not an oversight. Reading a manifest needs no network at
 * all, so every `api.fetch` this module attempts is refused.
 */
export async function readManifestFromSource(source: string): Promise<PluginManifest> {
  const raw = await runPlugin({
    hosts: [],
    selfOrigin: globalThis.location?.origin ?? '',
    spawn: spawnManifestReader(source),
    fetchUrl: pageFetch,
    timeoutMs: MANIFEST_TIMEOUT_MS,
  })
  return parseManifest(raw)
}

/**
 * The one spelling of a repository address that gets stored.
 *
 * The registry key is a hash of this, and an update is refused when it does
 * not match what the manifest declares — so a value that varies with how
 * someone typed it would refuse every legitimate update, for ever.
 */
export function canonicalRepoUrl(repoUrl: string): string {
  const { owner, repo } = repoParts(repoUrl)
  return `https://github.com/${owner}/${repo}`
}

function repoParts(repoUrl: string): { owner: string; repo: string } {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    throw new Error('plugin source: not a URL')
  }
  if (url.protocol !== 'https:') throw new Error('plugin source: must be https')
  if (url.hostname.toLowerCase().replace(/\.+$/, '') !== 'github.com') {
    throw new Error('plugin source: only github repositories are supported')
  }
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('plugin source: not a repository path')
  return { owner: parts[0], repo: parts[1] }
}

export function gitSourceUrls(repoUrl: string): { rawUrl: string; commitApi: string } {
  const { owner, repo } = repoParts(repoUrl)
  return {
    // HEAD rather than a branch name: a repository that renamed its default
    // branch keeps working, and a plugin installed today keeps updating.
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${PLUGIN_FILE}`,
    commitApi: `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`,
  }
}

export async function fetchGitPlugin(repoUrl: string, deps: InstallDeps = {}): Promise<{ source: string; commit: string }> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const { rawUrl, commitApi } = gitSourceUrls(repoUrl)

  const sourceResponse = await request(rawUrl, { credentials: 'omit', cache: 'no-store' })
  if (!sourceResponse.ok) throw new Error(`plugin source: repository has no ${PLUGIN_FILE} (${sourceResponse.status})`)
  const source = await sourceResponse.text()

  // The commit is what an update compares against. A repository that will not
  // report one is still installable; it simply never reports an update.
  let commit = ''
  try {
    const commitResponse = await request(commitApi, { credentials: 'omit', cache: 'no-store' })
    if (commitResponse.ok) {
      const body = await commitResponse.json() as { sha?: unknown }
      if (typeof body.sha === 'string') commit = body.sha
    }
  } catch {
    // Rate limited or offline: the source is in hand, which is what matters.
  }
  return { source, commit }
}

export async function buildInstall(source: string, origin: PluginOrigin, deps: InstallDeps = {}): Promise<InstalledPlugin> {
  const read = deps.readManifest ?? readManifestFromSource
  const manifest = await read(source)
  // A file that declares where it updates from keeps that address, so a
  // dropped plugin is not stranded on the version that happened to be dropped.
  // A repository address is canonicalised, because the id is a hash of it.
  const resolved: PluginOrigin = origin.kind === 'file'
    ? { ...origin, updateUrl: origin.updateUrl ?? manifest.updateUrl }
    : { ...origin, updateUrl: canonicalRepoUrl(origin.updateUrl) }
  return {
    // Derived from the resolved origin, so two spellings of one repository
    // are one plugin. Safe for a file too: originKey reads only the file name
    // and deliberately ignores the updateUrl the manifest just supplied, so
    // the id does not move when a dropped file learns where it lives.
    id: await originId(resolved),
    manifest,
    source,
    sha256: await sha256Hex(source),
    origin: resolved,
    approvedHosts: [...manifest.hosts],
    enabled: true,
    pendingUpdate: null,
    installedAt: Date.now(),
  }
}
