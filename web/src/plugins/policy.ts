export type FetchDenial = 'invalid' | 'scheme' | 'self-origin' | 'private-host' | 'host-not-declared'

export type FetchDecision =
  | { ok: true; url: URL }
  | { ok: false; reason: FetchDenial }

// A literal address is never a legitimate target for a catalog addon, and it
// is the shape an attempt at the local network takes. Public literals go too:
// an addon lives at a name, so a plugin asking for a bare address is either
// probing or being clever.
//
// What this cannot catch is a name that resolves into private space — the
// browser will not tell us the address it landed on. That limit is written
// into the spec and into the docs, and it is why the server keeps its own
// guard for the URLs a plugin hands it.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const PRIVATE_NAMES = new Set(['localhost'])

/**
 * One spelling per host, so every check below compares the same thing.
 *
 * The trailing dot is the case that matters: `ss.giuli.dev.` is the same host
 * to DNS and a different string to everything here. Without this, it slips
 * past the self-origin check, and `localhost.` slips past isPrivateHostname.
 */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function isPrivateHostname(host: string): boolean {
  if (PRIVATE_NAMES.has(host) || host.endsWith('.localhost')) return true
  // URL keeps IPv6 in brackets, which no hostname ever has.
  if (host.startsWith('[')) return true
  if (IPV4.test(host)) return true
  return false
}

/**
 * Decides whether a plugin's request happens. The plugin never performs it —
 * the page does, after this — so this is the whole boundary.
 *
 * It is applied twice per request: once to where the request is going, and
 * again to where the response came from. A declared host is free to answer
 * 302, and checking only the first would make this a pre-flight formality.
 */
export function checkFetchUrl(raw: string, hosts: string[], selfOrigin: string): FetchDecision {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  // A selfOrigin that cannot be read must not become "this is not our origin".
  let self: URL
  try {
    self = new URL(selfOrigin)
  } catch {
    return { ok: false, reason: 'self-origin' }
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }

  const host = normalizeHost(url.hostname)
  // Compared by hostname rather than by origin. `origin` carries the port, and
  // a different port on the same host is still the application's own machine —
  // which is also a free port scanner for whatever else is bound there.
  if (host === normalizeHost(self.hostname)) return { ok: false, reason: 'self-origin' }
  if (isPrivateHostname(host)) return { ok: false, reason: 'private-host' }
  // Exact equality against a list parseManifest has already lowercased and
  // shape-checked. If that ever stops being true, this fails closed.
  if (!hosts.includes(host)) return { ok: false, reason: 'host-not-declared' }

  // No free Authorization: Basic for the declared host. The page performs this
  // request, and credentials in the URL are capability the policy never meant
  // to hand over.
  url.username = ''
  url.password = ''
  return { ok: true, url }
}
