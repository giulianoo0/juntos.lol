import { parseStreams, type CatalogStream, type StreamTarget } from '../catalog/streams'
import { runPlugin } from './runtime'
import { pageFetch, spawnPluginWorker } from './spawn'
import { listPlugins, type InstalledPlugin } from './store'

export type ResolveResult =
  | { kind: 'no-plugins' }
  | { kind: 'streams'; streams: CatalogStream[]; failed: string[] }

export interface ResolveDeps {
  load?: () => Promise<InstalledPlugin[]>
  run?: (plugin: InstalledPlugin, target: StreamTarget, signal?: AbortSignal) => Promise<unknown>
  signal?: AbortSignal
}

function runInWorker(plugin: InstalledPlugin, target: StreamTarget, signal?: AbortSignal): Promise<unknown> {
  return runPlugin({
    signal,
    hosts: plugin.approvedHosts,
    selfOrigin: globalThis.location?.origin ?? '',
    spawn: spawnPluginWorker(plugin.source, target),
    fetchUrl: pageFetch,
  })
}

/**
 * Asks every enabled plugin for this title in parallel; one that throws or runs
 * past its budget drops out silently and is named in `failed`.
 */
export async function resolveStreams(target: StreamTarget, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const load = deps.load ?? listPlugins
  const run = deps.run ?? runInWorker

  const enabled = (await load()).filter((plugin) => plugin.enabled)
  if (enabled.length === 0) return { kind: 'no-plugins' }

  const settled = await Promise.allSettled(enabled.map(async (plugin) => (
    parseStreams({ streams: await run(plugin, target, deps.signal) }, plugin.id, plugin.manifest.name)
  )))
  const streams = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  const failed = enabled
    .filter((_, index) => settled[index].status === 'rejected')
    .map((plugin) => plugin.manifest.name)
  return { kind: 'streams', streams, failed }
}
