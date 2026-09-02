import { parseManifest, type PluginManifest } from './manifest'
import { runPlugin } from './runtime'
import { pageFetch, readCapped, spawnManifestReader } from './spawn'
import { originId, sha256Hex, type InstalledPlugin, type PluginOrigin } from './store'

export interface InstallDeps {
  fetch?: typeof globalThis.fetch
  readManifest?: (source: string) => Promise<PluginManifest>
}

const PLUGIN_FILE = 'plugin.js'

const MAX_SOURCE_BYTES = 1 << 20

const SEGMENT = /^[a-z0-9._-]+$/
const DOTS = /^\.+$/
const DOT_SEGMENT = /\/(\.|%2e){1,2}(\/|$|\?|#)/i

const MANIFEST_TIMEOUT_MS = 5_000

/** Runs the module in a worker, never in the page, and with no network access. */
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
  if (DOT_SEGMENT.test(repoUrl)) throw new Error('plugin source: path must name a repository directly')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('plugin source: not a repository path')
  const owner = parts[0].toLowerCase()
  const repo = parts[1].replace(/\.git$/i, '').toLowerCase()
  for (const part of [owner, repo]) {
    if (part === '' || DOTS.test(part) || !SEGMENT.test(part)) {
      throw new Error('plugin source: not a repository path')
    }
  }
  return { owner, repo }
}

export function gitSourceUrls(repoUrl: string): { rawUrl: string; commitApi: string } {
  const { owner, repo } = repoParts(repoUrl)
  return {
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${PLUGIN_FILE}`,
    commitApi: `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`,
  }
}

export async function fetchGitPlugin(repoUrl: string, deps: InstallDeps = {}): Promise<{ source: string; commit: string }> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const { rawUrl, commitApi } = gitSourceUrls(repoUrl)

  const sourceResponse = await request(rawUrl, { credentials: 'omit', cache: 'no-store', redirect: 'follow' })
  if (!sourceResponse.ok) throw new Error(`plugin source: repository has no ${PLUGIN_FILE} (${sourceResponse.status})`)
  const source = await readCapped(sourceResponse, MAX_SOURCE_BYTES + 1)
  if (source.length > MAX_SOURCE_BYTES) throw new Error(`plugin source: ${PLUGIN_FILE} is too large`)
  if (source.trim() === '') throw new Error(`plugin source: ${PLUGIN_FILE} is empty`)

  let commit = ''
  try {
    const commitResponse = await request(commitApi, { credentials: 'omit', cache: 'no-store' })
    if (commitResponse.ok) {
      const body = JSON.parse(await readCapped(commitResponse, MAX_SOURCE_BYTES)) as { sha?: unknown }
      if (typeof body.sha === 'string') commit = body.sha
    }
  } catch (error) {
    console.warn('plugin source: could not read the commit', error)
  }
  return { source, commit }
}

/** Canonical repository the plugin updates from, or null when it is not a GitHub one. */
function homeOf(updateUrl: string | null): string | null {
  if (!updateUrl) return null
  try {
    return canonicalRepoUrl(updateUrl)
  } catch {
    return null
  }
}

export async function buildInstall(source: string, origin: PluginOrigin, deps: InstallDeps = {}): Promise<InstalledPlugin> {
  const read = deps.readManifest ?? readManifestFromSource
  const manifest = await read(source)
  const resolved: PluginOrigin = origin.kind === 'file'
    ? { ...origin, updateUrl: origin.updateUrl ?? homeOf(manifest.updateUrl) }
    : { ...origin, updateUrl: canonicalRepoUrl(origin.updateUrl) }
  return {
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
