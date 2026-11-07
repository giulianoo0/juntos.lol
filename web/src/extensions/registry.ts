/**
 * The server's registry of extension ids, and the manifests behind them.
 * Every answer is checked here too: what the page later trusts (the hosts a
 * source may come from) comes out of these manifests.
 */
import type { ExtensionManifest } from './protocol'

export interface RegisteredExtension {
  id: string
  name: string
  sub: string
  source: string
  icon?: string
}

export interface ExtensionVersion {
  version: string
  manifestUrl: string
}

export type ExtensionErrorCode = 'id_taken' | 'bad_manifest' | 'not_open_source' | 'not_found' | 'busy' | 'bad_repo' | 'bad_id' | 'not_allowed' | 'failed'

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode
  constructor(code: ExtensionErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ExtensionError'
    this.code = code
  }
}

const ID = /^[a-z][a-z0-9-]{2,31}$/
const SUB = /^[a-z2-7]{16}$/
const SHA = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

type Plain = Record<string, unknown>
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value)

// The same rules as the registry in Go (internal/extension/manifest.go) and
// the extension host, case by case in extensions/manifest-cases.json.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]*[a-z0-9]$`)
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$/
const KEYS = ['id', 'name', 'version', 'protocol', 'entry', 'icon', 'hosts', 'captcha']
const HOST_KEYS = ['connect', 'images', 'media']
const RESERVED = ['juntos.lol', 'santamagia.com']
const MAX_HOSTS = 16

/** Length in code points, as Go counts runes. */
const runes = (value: string) => [...value].length
/** "" and null count as absent, as in Go. */
const given = (value: unknown) => value !== undefined && value !== null && value !== ''

function sameKeys(object: Plain, known: string[]): boolean {
  return Object.keys(object).every((key) => known.includes(key) || !known.includes(key.toLowerCase()))
}

function relativePath(value: unknown, exts: readonly string[]): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  if (!exts.some((ext) => value.endsWith(`.${ext}`))) return false
  return value.split('/').every((part) => SEGMENT.test(part) && !part.includes('..'))
}

function validHost(entry: string, wildcard: boolean): boolean {
  const host = wildcard && entry.startsWith('*.') ? entry.slice(2) : entry
  if (host.length > 253 || !HOST.test(host) || host.endsWith('.localhost')) return false
  return !RESERVED.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function hostList(value: unknown, wildcard: boolean): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_HOSTS) return null
  return value.every((entry) => typeof entry === 'string' && validHost(entry, wildcard)) ? [...value] as string[] : null
}

export function parseManifest(value: unknown): ExtensionManifest | null {
  if (!isPlain(value) || !sameKeys(value, KEYS)) return null
  const { id, version, protocol, entry, icon, captcha } = value
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (typeof id !== 'string' || !ID.test(id) || id === 'host' || name === '' || runes(name) > 64) return null
  if (typeof version !== 'string' || version === '' || runes(version) > 64 || protocol !== 1) return null
  if (!relativePath(entry, ['html']) || (given(icon) && !relativePath(icon, ['png', 'svg']))) return null
  if (given(captcha) && captcha !== 'hcaptcha') return null
  const hosts = value.hosts ?? {}
  if (!isPlain(hosts) || !sameKeys(hosts, HOST_KEYS)) return null
  const connect = hostList(hosts.connect, false)
  const images = hostList(hosts.images, false)
  const media = hostList(hosts.media, true)
  if (!connect || !images || !media) return null
  return {
    id, name, version, protocol: 1, entry,
    ...(given(icon) ? { icon: icon as string } : {}),
    hosts: { connect, images, media },
    ...(given(captcha) ? { captcha: 'hcaptcha' as const } : {}),
  }
}

function registered(value: unknown): RegisteredExtension | null {
  if (!isPlain(value)) return null
  const { id, name, sub, source, icon } = value
  if (typeof id !== 'string' || !ID.test(id) || typeof name !== 'string' || name === '' || runes(name) > 64 || typeof sub !== 'string' || !SUB.test(sub)) return null
  if (typeof source !== 'string' || !/^github:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(source)) return null
  if (given(icon) && !relativePath(icon, ['png', 'svg'])) return null
  return { id, name, sub, source, ...(given(icon) ? { icon: icon as string } : {}) }
}

/** The registered extension with that id; installing starts here. */
export async function findExtension(raw: string): Promise<RegisteredExtension> {
  const id = raw.trim().toLowerCase()
  if (!ID.test(id)) throw new ExtensionError('bad_id')
  const response = await fetch(`/api/extensions/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } })
  if (response.status === 404) throw new ExtensionError('not_found')
  if (!response.ok) throw new ExtensionError('failed', `find ${response.status}`)
  const found = registered(await response.json().catch(() => null))
  if (!found || found.id !== id) throw new ExtensionError('failed', 'answer does not add up')
  return found
}

/** `dono/repo` out of what someone typed or pasted, or null. */
export function parseRepo(raw: string): string | null {
  const repo = raw.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  return REPO.test(repo) && !repo.split('/').some((part) => part === '.' || part === '..') ? repo : null
}

function refusal(status: number, code: unknown): ExtensionErrorCode {
  if (code === 'id_taken' || code === 'bad_manifest' || code === 'not_open_source' || code === 'bad_repo') return code
  if (code === 'repo_not_found') return 'not_found'
  if (status === 401 || status === 403) return 'not_allowed'
  if (status === 429) return 'busy'
  return 'failed'
}

/** Registers the repo's id for it; the same repo again is fine. */
export async function registerExtension(repo: string): Promise<{ id: string; sub: string; version: string; manifest: ExtensionManifest }> {
  const response = await fetch('/api/extensions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  })
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new ExtensionError(refusal(response.status, isPlain(body) ? body.error : undefined))
  if (!isPlain(body)) throw new ExtensionError('failed', 'empty answer')
  const manifest = parseManifest(body.manifest)
  if (!manifest) throw new ExtensionError('bad_manifest')
  const { id, sub, sha } = body
  if (id !== manifest.id || typeof sub !== 'string' || !SUB.test(sub) || typeof sha !== 'string' || !SHA.test(sha)) {
    throw new ExtensionError('failed', 'answer does not add up')
  }
  return { id: manifest.id, sub, version: sha, manifest }
}

const GITHUB_RAW = 'https://raw.githubusercontent.com'

/** The version to load, the repository's HEAD sha, and where its manifest is. */
export async function resolveVersion(entry: Pick<RegisteredExtension, 'id' | 'source'>, raw = GITHUB_RAW): Promise<ExtensionVersion> {
  const response = await fetch(`/api/extensions/${encodeURIComponent(entry.id)}/latest`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ExtensionError('failed', `latest ${response.status}`)
  const body = await response.json() as unknown
  const sha = isPlain(body) ? body.sha : undefined
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new ExtensionError('failed', 'not a commit')
  const repo = entry.source.slice('github:'.length)
  return { version: sha, manifestUrl: `${raw}/${repo}/${sha}/juntos.json` }
}

export async function fetchManifest(url: string, id: string): Promise<ExtensionManifest> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ExtensionError('failed', `manifest ${response.status}`)
  const manifest = parseManifest(await response.json().catch(() => null))
  if (!manifest || manifest.id !== id) throw new ExtensionError('bad_manifest')
  return manifest
}

/** The newest version of a registered id and its manifest. */
export async function latestExtension(id: string, raw?: string): Promise<{ id: string; sub: string; version: string; manifest: ExtensionManifest }> {
  const entry = await findExtension(id)
  const { version, manifestUrl } = await resolveVersion(entry, raw)
  const manifest = await fetchManifest(manifestUrl, entry.id)
  return { id: entry.id, sub: entry.sub, version, manifest }
}
