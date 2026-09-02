export type FetchDenial = 'invalid' | 'scheme' | 'self-origin' | 'private-host' | 'host-not-declared'

export type FetchDecision =
  | { ok: true; url: URL }
  | { ok: false; reason: FetchDenial }

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const PRIVATE_NAMES = new Set(['localhost'])

/** Lowercased and stripped of the trailing dot, so `host.` and `host` compare equal. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function isPrivateHostname(host: string): boolean {
  if (PRIVATE_NAMES.has(host) || host.endsWith('.localhost')) return true
  if (host.startsWith('[')) return true
  if (IPV4.test(host)) return true
  return false
}

/**
 * The whole boundary: the plugin never performs the request, the server does
 * on the page's behalf. Applied twice — to where the request goes, and to
 * where the response came from.
 */
export function checkFetchUrl(raw: string, hosts: string[], selfOrigin: string): FetchDecision {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  let self: URL
  try {
    self = new URL(selfOrigin)
  } catch {
    return { ok: false, reason: 'self-origin' }
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }

  const host = normalizeHost(url.hostname)
  if (host === normalizeHost(self.hostname)) return { ok: false, reason: 'self-origin' }
  if (isPrivateHostname(host)) return { ok: false, reason: 'private-host' }
  if (!hosts.includes(host)) return { ok: false, reason: 'host-not-declared' }

  url.username = ''
  url.password = ''
  return { ok: true, url }
}
