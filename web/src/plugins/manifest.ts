/** What a plugin says about itself. Read once at install, then stored. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  /** Hostnames the plugin is allowed to reach. Never empty. */
  hosts: string[]
  /** Where the plugin updates itself from, or null for a file with no home. */
  updateUrl: string | null
}

// A label, and nothing more. Identity between versions is the locked origin,
// not this — a manifest is free to claim whatever id it likes.
const ID_PATTERN = /^[a-z0-9-]{1,64}$/

// A bare hostname: labels of letters, digits and hyphens joined by dots. No
// scheme, no port, no path — the policy compares hostnames, and anything
// carrying more than a hostname would compare against something that never
// appears on the other side. At least one dot is required, which rules out
// single-label names: there is no addon on the public internet at `intranet`,
// and allowing one only widens what a declared host can reach.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const MAX_ID = 64
const MAX_NAME = 64
const MAX_VERSION = 32
const MAX_HOSTS = 16
const MAX_HOST_LENGTH = 253
const MAX_UPDATE_URL = 512

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`plugin manifest: ${field} is missing or invalid`)
  }
  return value.trim()
}

export function parseManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null) throw new Error('plugin manifest: not an object')
  const raw = value as Record<string, unknown>

  const id = text(raw.id, 'id', MAX_ID)
  if (!ID_PATTERN.test(id)) throw new Error('plugin manifest: id must match [a-z0-9-]')

  const name = text(raw.name, 'name', MAX_NAME)
  const version = text(raw.version, 'version', MAX_VERSION)

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0 || raw.hosts.length > MAX_HOSTS) {
    throw new Error('plugin manifest: hosts must be a non-empty list')
  }
  const hosts = raw.hosts.map((host) => {
    // 253 is the longest a hostname can legally be. Without a ceiling here,
    // hosts is the one field with no length limit at all.
    if (typeof host !== 'string' || host.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(host.toLowerCase())) {
      throw new Error('plugin manifest: hosts must be bare hostnames')
    }
    return host.toLowerCase()
  })

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
    updateUrl = candidate
  }

  return { id, name, version, hosts, updateUrl }
}
