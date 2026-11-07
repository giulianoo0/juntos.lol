/**
 * The juntos ↔ extension contract (protocol v1). An extension runs on its own
 * origin and only talks through postMessage; everything it sends is untrusted
 * until it passes here, and what passes is rebuilt field by field so nothing
 * it attached rides along.
 */

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

export interface ThemeTokens {
  mode: 'dark' | 'light'
  vars: Record<string, string>
}

/** Request headers a CDN insists on; only the desktop app can send them. */
export type ExtHeaders = Partial<Record<(typeof HEADER_NAMES)[number], string>>

export type ExtUrlSource = { kind: 'hls' | 'file'; url: string; headers?: ExtHeaders }
export type ExtTorrentSource = { kind: 'torrent'; infoHash: string; fileIdx?: number; trackers?: string[] }
export type ExtYoutubeSource = { kind: 'youtube'; id: string }
export type ExtSource = ExtUrlSource | ExtTorrentSource | ExtYoutubeSource

export interface ExtSubtitle { url: string; lang: string; label?: string }

export type HostToExt =
  | { juntos: 1; type: 'init'; theme: ThemeTokens; locale: string; canPlay: boolean; app: boolean }
  | { juntos: 1; type: 'theme'; theme: ThemeTokens }
  | { juntos: 1; type: 'refresh'; nonce: string; ref: string }

export type ExtPlay = {
  juntos: 1; type: 'play'; title: string; subtitle?: string; poster?: string; ref: string; source: ExtSource; subtitles?: ExtSubtitle[]
}

export type ExtToHost =
  | { juntos: 1; type: 'ready' }
  | ExtPlay
  | { juntos: 1; type: 'refreshed'; nonce: string; source: ExtSource | null }
  | { juntos: 1; type: 'close' }
  | { juntos: 1; type: 'toast'; text: string }

export interface ExtensionPlace {
  base: string
  scheme: 'https' | 'http'
  /** Where extension repositories are read raw, GitHub's own by default. */
  raw?: string
}

const PROD_PLACE: ExtensionPlace = { base: 'santamagia.com', scheme: 'https' }

const MAX_TEXT = 300
const MAX_REF = 128
const MAX_URL = 2048
const MAX_TRACKERS = 20
const MAX_TRACKER_URL = 300
const MAX_SUBTITLES = 16
const MAX_FILE_INDEX = 9999
const MAX_HEADER = 512
const HEADER_NAMES = ['user-agent', 'referer', 'origin'] as const
const INFO_HASH = /^[0-9a-f]{40}$/i
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const LANG = /^[A-Za-z0-9-]{2,16}$/

export function extensionOrigin(sub: string, place: ExtensionPlace = PROD_PLACE): string {
  return `${place.scheme}://${sub}.${place.base}`
}

type Plain = Record<string, unknown>

/** A plain object literal, never an array or something with a borrowed prototype. */
function plain(value: unknown): Plain | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null ? value as Plain : null
}

function own(object: Plain, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** Whether `host` is one of `allowed`; `*.domain` takes any subdomain, not the domain itself, and `*` any host. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => entry === '*' || entry.startsWith('*.')
    ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
    : host === entry)
}

/**
 * Whether `raw` is an https url, without credentials or port, on one of
 * `allowed`, and never this page's own host: read from here, it would carry
 * the person's juntos cookies.
 */
export function urlAllowed(raw: string, allowed: readonly string[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  if (url.hostname === globalThis.location?.hostname) return false
  return hostAllowed(url.hostname, allowed)
}

function safeUrl(value: unknown, allowed: readonly string[]): string | null {
  const raw = text(value, MAX_URL)
  return raw !== null && urlAllowed(raw, allowed) ? raw : null
}

/** A host that is this machine or its network, written as such. */
function localHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[')) return true
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/**
 * A media url as the desktop app may read it: http too, and a port. Never
 * this page's host, credentials, or an address on the person's own network.
 */
export function mediaUrlAllowed(raw: string, allowed: readonly string[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return false
  if (url.hostname === globalThis.location?.hostname || localHost(url.hostname)) return false
  return hostAllowed(url.hostname, allowed)
}

/** Whether only the desktop app can read this source: plain http, a port, or headers the browser cannot send. */
export function needsApp(source: ExtSource): boolean {
  if (source.kind !== 'hls' && source.kind !== 'file') return false
  if (source.headers) return true
  const url = new URL(source.url)
  return url.protocol !== 'https:' || url.port !== ''
}

function headers(value: unknown): ExtHeaders | null | undefined {
  if (value === undefined) return undefined
  const object = plain(value)
  if (!object) return null
  const out: ExtHeaders = {}
  for (const [key, raw] of Object.entries(object)) {
    const name = key.toLowerCase() as (typeof HEADER_NAMES)[number]
    if (!HEADER_NAMES.includes(name) || name in out) return null
    const said = text(raw, MAX_HEADER)
    if (said === null || /[\r\n\0]/.test(said)) return null
    out[name] = said
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function trackers(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TRACKERS) return null
  const out: string[] = []
  for (const entry of value) {
    const raw = text(entry, MAX_TRACKER_URL)
    if (raw === null) return null
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (!['udp:', 'http:', 'https:'].includes(url.protocol) || localHost(url.hostname)) return null
    out.push(raw)
  }
  return out
}

function source(value: unknown, manifest: ExtensionManifest): ExtSource | null {
  const object = plain(value)
  if (!object) return null
  const kind = own(object, 'kind')
  if (kind === 'hls' || kind === 'file') {
    const raw = text(own(object, 'url'), MAX_URL)
    const sent = headers(own(object, 'headers'))
    if (raw === null || !mediaUrlAllowed(raw, manifest.hosts.media) || sent === null) return null
    return sent ? { kind, url: raw, headers: sent } : { kind, url: raw }
  }
  if (kind === 'torrent') {
    const infoHash = own(object, 'infoHash')
    const fileIdx = own(object, 'fileIdx')
    const tracked = trackers(own(object, 'trackers'))
    if (typeof infoHash !== 'string' || !INFO_HASH.test(infoHash) || tracked === null) return null
    if (fileIdx !== undefined && (!Number.isInteger(fileIdx) || (fileIdx as number) < 0 || (fileIdx as number) > MAX_FILE_INDEX)) return null
    const out: ExtTorrentSource = { kind, infoHash: infoHash.toLowerCase() }
    if (fileIdx !== undefined) out.fileIdx = fileIdx as number
    if (tracked && tracked.length > 0) out.trackers = tracked
    return out
  }
  if (kind === 'youtube') {
    const id = own(object, 'id')
    return typeof id === 'string' && YOUTUBE_ID.test(id) ? { kind, id } : null
  }
  return null
}

function subtitles(value: unknown, manifest: ExtensionManifest): ExtSubtitle[] | null {
  if (!Array.isArray(value) || value.length > MAX_SUBTITLES) return null
  const out: ExtSubtitle[] = []
  for (const entry of value) {
    const object = plain(entry)
    if (!object) return null
    const url = safeUrl(own(object, 'url'), manifest.hosts.media)
    const lang = text(own(object, 'lang'), 16)
    if (url === null || lang === null || !LANG.test(lang)) return null
    const item: ExtSubtitle = { url, lang }
    const label = own(object, 'label')
    if (label !== undefined) {
      const said = text(label, 64)
      if (said === null) return null
      item.label = said
    }
    out.push(item)
  }
  return out
}

/** The magnet a torrent source stands for. */
export function torrentMagnet(source: ExtTorrentSource, name?: string): string {
  const params = [`xt=urn:btih:${source.infoHash}`]
  if (name) params.push(`dn=${encodeURIComponent(name)}`)
  for (const tracker of source.trackers ?? []) params.push(`tr=${encodeURIComponent(tracker)}`)
  return `magnet:?${params.join('&')}`
}

export function parseExtMessage(data: unknown, manifest: ExtensionManifest): ExtToHost | null {
  const message = plain(data)
  if (!message || own(message, 'juntos') !== 1) return null
  switch (own(message, 'type')) {
    case 'ready': return { juntos: 1, type: 'ready' }
    case 'close': return { juntos: 1, type: 'close' }
    case 'toast': {
      const said = text(own(message, 'text'))
      return said === null ? null : { juntos: 1, type: 'toast', text: said }
    }
    case 'refreshed': {
      const nonce = text(own(message, 'nonce'), MAX_REF)
      if (nonce === null) return null
      // A source that does not pass is an answer all the same: no source,
      // so the host stops waiting for this nonce now instead of timing out.
      return { juntos: 1, type: 'refreshed', nonce, source: source(own(message, 'source'), manifest) }
    }
    case 'play': {
      const title = text(own(message, 'title'))
      const ref = text(own(message, 'ref'), MAX_REF)
      const found = source(own(message, 'source'), manifest)
      if (title === null || ref === null || found === null) return null
      const out: ExtPlay = { juntos: 1, type: 'play', title, ref, source: found }
      const subtitle = own(message, 'subtitle')
      if (subtitle !== undefined) {
        const said = text(subtitle)
        if (said === null) return null
        out.subtitle = said
      }
      const poster = own(message, 'poster')
      if (poster !== undefined) {
        const url = safeUrl(poster, manifest.hosts.images)
        if (url === null) return null
        out.poster = url
      }
      const subs = own(message, 'subtitles')
      if (subs !== undefined) {
        const found = subtitles(subs, manifest)
        if (found === null) return null
        if (found.length > 0) out.subtitles = found
      }
      return out
    }
    default: return null
  }
}
