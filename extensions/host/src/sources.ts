import { parseManifest, type ExtensionManifest } from './manifest'

export interface Deps {
  fetch: typeof fetch
  cache?: Cache
}

export type Source = { kind: 'github'; owner: string; repo: string }
export interface Registered {
  id: string
  source: Source
}

export class UpstreamError extends Error {}

const SHA = /^[0-9a-f]{40}$/
const GH_PART = /^(?!\.)[A-Za-z0-9_.-]{1,100}$/

function parseSource(raw: unknown): Source | null {
  if (typeof raw !== 'string') return null
  const m = /^github:([^/]+)\/([^/]+)$/.exec(raw)
  if (m && GH_PART.test(m[1]) && GH_PART.test(m[2])) return { kind: 'github', owner: m[1], repo: m[2] }
  return null
}

async function cachedFetch(url: string, ttl: number, deps: Deps): Promise<Response> {
  const hit = await deps.cache?.match(url)
  if (hit) return hit
  let res: Response
  try {
    res = await deps.fetch(url, { headers: { accept: 'application/json' } })
  } catch {
    throw new UpstreamError(url)
  }
  if (res.status >= 500) throw new UpstreamError(url)
  if (deps.cache) {
    const copy = new Response(await res.arrayBuffer(), { status: res.status, headers: { 'cache-control': `max-age=${ttl}` } })
    await deps.cache.put(url, copy.clone())
    return copy
  }
  return res
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new UpstreamError('json')
  }
}

export async function lookupSub(sub: string, juntosOrigin: string, deps: Deps): Promise<Registered | null> {
  const res = await cachedFetch(`${juntosOrigin}/api/extensions/host/${sub}`, 60, deps)
  if (res.status === 404) return null
  if (!res.ok) throw new UpstreamError('registry')
  const body = (await readJson(res)) as { id?: unknown; source?: unknown } | null
  const source = parseSource(body?.source)
  if (typeof body?.id !== 'string' || !source) throw new UpstreamError('registry')
  return { id: body.id, source }
}

/** The sha juntos serves the extension at; `fresh` skips the minute this host keeps it. */
export async function currentVersion(reg: Registered, juntosOrigin: string, deps: Deps, fresh = false): Promise<string> {
  const url = `${juntosOrigin}/api/extensions/${reg.id}/latest`
  if (fresh) await deps.cache?.delete(url)
  const res = await cachedFetch(url, 60, deps)
  const sha = res.ok ? ((await readJson(res)) as { sha?: unknown } | null)?.sha : null
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new UpstreamError('latest')
  return sha
}

export const GITHUB_RAW = 'https://raw.githubusercontent.com'

export function fileUrl(reg: Registered, version: string, path: string, rawBase = GITHUB_RAW): string | null {
  const s = reg.source
  return SHA.test(version) ? `${rawBase}/${s.owner}/${s.repo}/${version}/${path}` : null
}

export async function loadManifest(reg: Registered, version: string, rawBase: string, deps: Deps): Promise<ExtensionManifest | null> {
  const url = fileUrl(reg, version, 'juntos.json', rawBase)
  if (!url) return null
  const res = await cachedFetch(url, 300, deps)
  if (!res.ok) throw new UpstreamError('manifest')
  const m = parseManifest(await readJson(res))
  if (!m || m.id !== reg.id) throw new UpstreamError('manifest')
  return m
}
