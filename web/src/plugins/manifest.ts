/** What a plugin says about itself. Read once at install, then stored. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  hosts: string[]
  updateUrl: string | null
}

const ID_PATTERN = /^[a-z0-9-]{1,64}$/

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const MAX_ID = 64
const MAX_NAME = 64
const MAX_VERSION = 32
const MAX_HOSTS = 16
const MAX_HOST_LENGTH = 253
const MAX_LABEL_LENGTH = 63
const MAX_UPDATE_URL = 512

const CONTROL = /\p{C}/u

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`plugin manifest: ${field} is missing or invalid`)
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max || CONTROL.test(trimmed)) {
    throw new Error(`plugin manifest: ${field} is missing or invalid`)
  }
  return trimmed
}

/**
 * One host, lowercased, in the exact spelling the policy compares against:
 * anything the URL parser would rewrite, and any literal address, is refused.
 */
function hostname(value: unknown): string {
  const invalid = () => new Error('plugin manifest: hosts must be bare hostnames')
  if (typeof value !== 'string' || value.length > MAX_HOST_LENGTH) throw invalid()
  const host = value.toLowerCase()
  if (!HOST_PATTERN.test(host)) throw invalid()
  if (host.split('.').some((label) => label.length > MAX_LABEL_LENGTH)) throw invalid()
  if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) {
    throw new Error('plugin manifest: hosts must be names, not addresses')
  }
  let parsed: URL
  try {
    parsed = new URL(`https://${host}`)
  } catch {
    throw invalid()
  }
  if (parsed.hostname !== host) throw invalid()
  return host
}

export function parseManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null) throw new Error('plugin manifest: not an object')
  const raw = value as Record<string, unknown>

  const id = text(raw.id, 'id', MAX_ID)
  if (!ID_PATTERN.test(id)) throw new Error('plugin manifest: id must match [a-z0-9-]')

  const name = text(raw.name, 'name', MAX_NAME)
  const version = text(raw.version, 'version', MAX_VERSION)

  const declared: unknown = raw.hosts
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('plugin manifest: hosts must be a non-empty list')
  }
  if (declared.length > MAX_HOSTS) {
    throw new Error(`plugin manifest: hosts must have at most ${MAX_HOSTS} entries`)
  }
  const hosts: string[] = []
  for (let index = 0; index < declared.length; index += 1) {
    const host = hostname(declared[index])
    if (!hosts.includes(host)) hosts.push(host)
  }

  let updateUrl: string | null = null
  if (raw.updateUrl !== undefined && raw.updateUrl !== null) {
    const candidate = text(raw.updateUrl, 'updateUrl', MAX_UPDATE_URL)
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error('plugin manifest: updateUrl is not a URL')
    }
    if (parsed.protocol !== 'https:') throw new Error('plugin manifest: updateUrl must be https')
    if (parsed.username || parsed.password) {
      throw new Error('plugin manifest: updateUrl must not carry credentials')
    }
    parsed.hash = ''
    updateUrl = parsed.href.replace(/\/+$/, '')
  }

  return { id, name, version, hosts, updateUrl }
}
