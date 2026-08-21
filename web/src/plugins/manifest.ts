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
const MAX_LABEL_LENGTH = 63
const MAX_UPDATE_URL = 512

// Control characters, including the bidirectional overrides. `name` and
// `version` exist only to be shown next to the hosts a plugin is asking for,
// and a name that can reorder the text around it is a name that can lie about
// what is being approved.
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
 * One host, in the exact spelling the policy will compare against.
 *
 * The policy matches `new URL(...).hostname` by equality, so anything the URL
 * parser would rewrite is a host that can never match — approved, displayed,
 * stored, and permanently dead. `127.1` and `1.2.3.04` are that; they are
 * rejected here rather than left to fail in silence later.
 *
 * An address is rejected outright, spelled however. The spec says a plugin
 * never reaches a literal address, and this is the layer where a literal
 * would otherwise be written into the approved hosts and shown on the consent
 * screen as though it were a name.
 */
function hostname(value: unknown): string {
  const invalid = () => new Error('plugin manifest: hosts must be bare hostnames')
  if (typeof value !== 'string' || value.length > MAX_HOST_LENGTH) throw invalid()
  const host = value.toLowerCase()
  if (!HOST_PATTERN.test(host)) throw invalid()
  if (host.split('.').some((label) => label.length > MAX_LABEL_LENGTH)) throw invalid()
  // A final label of only digits is the URL parser's own rule for "this is an
  // IPv4 address", which catches 1.2.3.4 and 0x7f.0x1 alike.
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

  // Read once. A manifest is an object third-party code built, and re-reading
  // `raw.hosts` invites a getter that answers differently each time.
  const declared: unknown = raw.hosts
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('plugin manifest: hosts must be a non-empty list')
  }
  if (declared.length > MAX_HOSTS) {
    throw new Error(`plugin manifest: hosts must have at most ${MAX_HOSTS} entries`)
  }
  // By index rather than `.map`: map skips the holes of a sparse array, and
  // it resolves `map` on the object itself, which need not be the real one.
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
    // Credentials here would be sent on every automatic update, unattended,
    // for as long as the plugin is installed.
    if (parsed.username || parsed.password) {
      throw new Error('plugin manifest: updateUrl must not carry credentials')
    }
    // This string becomes the plugin's identity — the registry key is a hash
    // of it, and an update declaring a different one is refused. Two spellings
    // of the same repository must not become two plugins, and must not make a
    // legitimate update look like a redirect.
    parsed.hash = ''
    updateUrl = parsed.href.replace(/\/+$/, '')
  }

  return { id, name, version, hosts, updateUrl }
}
