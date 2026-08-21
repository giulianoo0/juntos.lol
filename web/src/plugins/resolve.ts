import { parseStreams, type CatalogStream, type StreamTarget } from '../catalog/streams'
import { runPlugin } from './runtime'
import { pageFetch, spawnPluginWorker } from './spawn'
import { listPlugins, type InstalledPlugin } from './store'

export type ResolveResult =
  | { kind: 'no-plugins' }
  | { kind: 'streams'; streams: CatalogStream[] }

export interface ResolveDeps {
  load?: () => Promise<InstalledPlugin[]>
  run?: (plugin: InstalledPlugin, target: StreamTarget) => Promise<unknown>
}

function runInWorker(plugin: InstalledPlugin, target: StreamTarget): Promise<unknown> {
  return runPlugin({
    // The hosts agreed to at install, never the ones the manifest currently
    // claims. A held update leaves those wider, and running against them
    // would grant exactly the capability the hold exists to withhold.
    hosts: plugin.approvedHosts,
    selfOrigin: globalThis.location?.origin ?? '',
    spawn: spawnPluginWorker(plugin.source, target),
    fetchUrl: pageFetch,
  })
}

/**
 * Asks every enabled plugin for this title, in parallel.
 *
 * "Nothing installed" and "installed, found nothing" are separate answers
 * because they are separate problems for the person looking at the screen:
 * one is fixed by installing a plugin, the other is not.
 *
 * A plugin that throws, or runs past its budget, drops out silently and takes
 * nobody else with it.
 */
export async function resolveStreams(target: StreamTarget, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const load = deps.load ?? listPlugins
  const run = deps.run ?? runInWorker

  const enabled = (await load()).filter((plugin) => plugin.enabled)
  if (enabled.length === 0) return { kind: 'no-plugins' }

  const settled = await Promise.allSettled(enabled.map(async (plugin) => (
    parseStreams({ streams: await run(plugin, target) }, plugin.id, plugin.manifest.name)
  )))
  const streams = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  return { kind: 'streams', streams }
}
