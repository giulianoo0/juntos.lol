export interface ExtensionManifest {
  id: string
  name: string
  version: string
  protocol: 1
  entry: string
  icon?: string
  hosts: { connect: string[]; images: string[]; media: string[] }
  captcha?: 'hcaptcha'
}

// The same rules as the registry in Go (internal/extension/manifest.go), case
// by case in extensions/manifest-cases.json.
const ID = /^[a-z][a-z0-9-]{2,31}$/
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]*[a-z0-9]$`)
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$/
const KEYS = ['id', 'name', 'version', 'protocol', 'entry', 'icon', 'hosts', 'captcha']
const HOST_KEYS = ['connect', 'images', 'media']
// juntos itself and the extensions' own place are never an extension's host.
const RESERVED = ['juntos.lol', 'santamagia.com']
export const ANY_HOST = '*'

type Plain = Record<string, unknown>
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Length in code points, as Go counts runes. */
const runes = (v: string) => [...v].length

function sameKeys(object: Plain, known: string[]): boolean {
  return Object.keys(object).every((key) => known.includes(key) || !known.some((k) => k === key.toLowerCase()))
}

function validHost(entry: string, wildcard: boolean): boolean {
  const host = wildcard && entry.startsWith('*.') ? entry.slice(2) : entry
  if (host.length > 253 || !HOST.test(host) || host.endsWith('.localhost')) return false
  return !RESERVED.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function hostList(v: unknown, wildcard: boolean): string[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 16) return null
  // ["*"], alone, is any host: an extension that reaches what the person tells it to.
  if (v.length === 1 && v[0] === ANY_HOST) return [ANY_HOST]
  return v.every((h) => typeof h === 'string' && validHost(h, wildcard)) ? [...v] as string[] : null
}

/** A path inside the extension that this host serves, ending in one of `exts`. */
function relPath(v: unknown, exts: readonly string[]): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) return false
  if (!exts.some((ext) => v.endsWith(`.${ext}`))) return false
  return v.split('/').every((seg) => SEGMENT.test(seg) && !seg.includes('..'))
}

/** "" and null count as absent, as in Go. */
const given = (v: unknown) => v !== undefined && v !== null && v !== ''

export function parseManifest(raw: unknown): ExtensionManifest | null {
  if (!isPlain(raw) || !sameKeys(raw, KEYS)) return null
  const m = raw
  if (typeof m.id !== 'string' || !ID.test(m.id) || m.id === 'host') return null
  const name = typeof m.name === 'string' ? m.name.trim() : ''
  if (name === '' || runes(name) > 64) return null
  if (typeof m.version !== 'string' || m.version === '' || runes(m.version) > 64 || m.protocol !== 1) return null
  if (!relPath(m.entry, ['html'])) return null
  if (given(m.icon) && !relPath(m.icon, ['png', 'svg'])) return null
  if (given(m.captcha) && m.captcha !== 'hcaptcha') return null
  const h = m.hosts ?? {}
  if (!isPlain(h) || !sameKeys(h, HOST_KEYS)) return null
  const connect = hostList(h.connect, false)
  const images = hostList(h.images, false)
  const media = hostList(h.media, true)
  if (!connect || !images || !media) return null
  const out: ExtensionManifest = { id: m.id, name, version: m.version, protocol: 1, entry: m.entry, hosts: { connect, images, media } }
  if (given(m.icon)) out.icon = m.icon as string
  if (given(m.captcha)) out.captcha = 'hcaptcha'
  return out
}

export function hostAllowed(hostname: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.startsWith('*.') ? hostname.endsWith(p.slice(1)) && hostname.length > p.length - 1 : hostname === p))
}
