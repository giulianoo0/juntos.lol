/**
 * The page's side of the ss helper — a small native app the host runs that
 * embeds a torrent engine and serves the bytes over localhost HTTP with CORS.
 *
 * It is the only way a torrent is opened. The helper reaches the TCP/uTP
 * swarm natively, knows exactly which bytes are ready, and serves them with
 * Range requests, so `read(start, end)` is a plain ranged fetch that blocks on
 * the helper until those bytes have downloaded. Nothing touches the VPS: the
 * browser uploads from the helper the same way it uploads a local file.
 */

import { isSubtitleFileName } from './subtitleFormats'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile } from './torrent'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
// A fixed loopback port the helper binds. Uncommon, to avoid clashing with the
// usual dev servers.
export const HELPER_ORIGIN = 'http://127.0.0.1:32227'
const HEALTH_TIMEOUT_MS = 600
// The leash for the probe that raises the permission prompt: long enough that
// the request outlives someone reading the bubble before clicking Allow.
const PROMPT_TIMEOUT_MS = 90_000
const AVAILABILITY_TTL_MS = 4_000

interface HelperFile {
  index: number
  name: string
  path: string
  size: number
}

interface AddResponse {
  id: string
  name: string
  files: HelperFile[]
}

let availabilityCheckedAt = 0
let availableCache = false
let helperVersionValue = ''
// The live Local Network Access verdict, once asked for. `permissionRead`
// separates "there is no such permission here" from "not looked up yet".
let permissionStatus: PermissionStatus | null = null
let permissionRead = false

/** The running helper's version, or '' when it is not reachable. */
export function helperVersion(): string {
  return helperVersionValue
}

async function withTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Forgets the cached availability, so the next check probes again. For tests. */
export function resetHelperAvailability(): void {
  availabilityCheckedAt = 0
  availableCache = false
}

/**
 * True when the ss helper is running and answering, cached briefly.
 *
 * Returns false without touching the network whenever the browser has not been
 * asked about local network access yet. That is the whole point of the gate:
 * the very first request to 127.0.0.1 is what raises the permission bubble, so
 * if anything but the explicit "I already installed it" button could fire it,
 * the bubble would turn up on a page the user was doing something else on —
 * and a permission asked for out of nowhere gets refused out of nowhere. Every
 * path into the helper goes through here, so none of them can raise it.
 */
export async function helperAvailable(): Promise<boolean> {
  if (!await mayReachHelper()) {
    availableCache = false
    helperVersionValue = ''
    return false
  }
  const now = Date.now()
  if (now - availabilityCheckedAt < AVAILABILITY_TTL_MS && availabilityCheckedAt !== 0) return availableCache
  availabilityCheckedAt = now
  try {
    const response = await withTimeout(`${HELPER_ORIGIN}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS)
    // Confirm it is actually our helper, not some other server on the port.
    const body = response.ok ? await response.json() as { name?: string; version?: string } : null
    availableCache = body?.name === 'ss-bridge'
    helperVersionValue = availableCache ? (body?.version ?? '') : ''
  } catch {
    availableCache = false
    helperVersionValue = ''
  }
  return availableCache
}

/**
 * The browser's Local Network Access verdict for this origin: 'prompt' means
 * the next request to 127.0.0.1 will raise the permission bubble, 'denied'
 * means every request is refused before it leaves the page, and 'unknown' is
 * every browser that does not gate loopback at all — where a plain fetch is
 * simply allowed.
 */
export async function localNetworkPermission(): Promise<PermissionState | 'unknown'> {
  // PermissionStatus.state is live, so a cached object never goes stale — the
  // user granting the permission is visible here on the next read, with no
  // event to wait for.
  if (permissionStatus) return permissionStatus.state
  if (permissionRead) return 'unknown'
  permissionRead = true
  // A page served from this machine is already in the local address space,
  // and loopback-to-loopback is never gated: the browser still reports
  // 'prompt' for it, but no prompt ever comes and the fetch goes through.
  if (pageIsLocal()) return 'unknown'
  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions
  if (!permissions?.query) return 'unknown'
  try {
    permissionStatus = await permissions.query({ name: 'local-network-access' as PermissionName })
    return permissionStatus.state
  } catch {
    // Browsers that do not know the name reject; that is the ungated case.
    return 'unknown'
  }
}

function pageIsLocal(): boolean {
  if (typeof location === 'undefined') return false
  const host = location.hostname
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

/**
 * Whether a request to the helper may go out at all: only once the permission
 * is granted, or in a browser that does not gate loopback in the first place.
 * 'prompt' is deliberately treated as no — see `helperAvailable`.
 */
async function mayReachHelper(): Promise<boolean> {
  const state = await localNetworkPermission()
  return state === 'granted' || state === 'unknown'
}

/**
 * Subscribes to that verdict changing, so the page reacts to the user answering
 * the bubble — or revoking the permission from the site settings later — without
 * having to poll for it. Returns a no-op when the browser has no such permission.
 */
export async function watchLocalNetworkPermission(
  onChange: (state: PermissionState) => void,
): Promise<() => void> {
  await localNetworkPermission()
  const status = permissionStatus
  if (!status) return () => undefined
  const listener = () => onChange(status.state)
  status.addEventListener('change', listener)
  return () => status.removeEventListener('change', listener)
}

/**
 * The one request in the app that is allowed to raise the permission bubble.
 *
 * It skips the gate in `helperAvailable` on purpose, because it is only ever
 * reached from the user clicking "I already installed it" — with the dialog
 * already explaining what is about to be asked and pointing at where it will
 * appear. Nothing else asks, so the bubble never arrives unexplained.
 *
 * It also drops the 600ms leash the background probe runs on. That timeout is
 * right for a poll and wrong here: aborting the request would take the bubble
 * waiting on it down too, so this one is given as long as a person plausibly
 * takes to read a prompt and click Allow.
 */
export async function requestHelperAccess(): Promise<boolean> {
  resetHelperAvailability()
  try {
    const response = await withTimeout(`${HELPER_ORIGIN}/health`, { method: 'GET' }, PROMPT_TIMEOUT_MS)
    const body = response.ok ? await response.json() as { name?: string; version?: string } : null
    availableCache = body?.name === 'ss-bridge'
    helperVersionValue = availableCache ? (body?.version ?? '') : ''
  } catch {
    availableCache = false
    helperVersionValue = ''
  }
  availabilityCheckedAt = Date.now()
  return availableCache
}

async function helperJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${HELPER_ORIGIN}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`helper ${path} failed (${response.status})`)
  // Some endpoints (/select, /close) answer with an empty 200.
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Opens a magnet in the helper. Reads are ranged fetches the helper answers
 * once the bytes are downloaded — the room plays while the torrent is still
 * coming down.
 */
export async function openHelperTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
): Promise<TorrentSession> {
  const added = await helperJson<AddResponse>('/add', { method: 'POST', body: JSON.stringify({ magnet }) })
  let selectedIndex = -1
  let destroyed = false

  const streamRange = async (index: number, start: number, endInclusive: number): Promise<ArrayBuffer> => {
    if (destroyed) throw new Error('torrent session closed')
    const response = await fetch(`${HELPER_ORIGIN}/stream/${encodeURIComponent(added.id)}/${index}`, {
      headers: { Range: `bytes=${start}-${endInclusive}` },
    })
    if (!response.ok && response.status !== 206) throw new Error(`helper stream failed (${response.status})`)
    const data = await response.arrayBuffer()
    const expected = endInclusive - start + 1
    if (data.byteLength !== expected) throw new Error(`helper short read (${data.byteLength}/${expected})`)
    return data
  }

  const files = added.files
    .filter((file) => VIDEO_EXTENSION.test(file.name))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      index: file.index,
      size: file.size,
      type: 'application/octet-stream',
      streamUrl: `${HELPER_ORIGIN}/stream/${encodeURIComponent(added.id)}/${file.index}`,
      // Progress is read off the session poll, not per file; the room only ever
      // plays the one selected file.
      get progress() { return 0 },
      get downloaded() { return 0 },
      read: (start, endInclusive) => streamRange(file.index, start, endInclusive),
    }))
    .sort((a, b) => b.size - a.size)

  const subtitleFiles = added.files
    .filter((file) => isSubtitleFileName(file.name) && file.size > 0 && file.size <= MAX_SIDE_FILE_BYTES)
    .map((file): TorrentSideFile => ({
      name: file.name,
      path: file.path,
      size: file.size,
      streamUrl: `${HELPER_ORIGIN}/stream/${encodeURIComponent(added.id)}/${file.index}`,
      read: () => streamRange(file.index, 0, file.size - 1),
    }))

  let currentStats: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }
  const refreshStats = async () => {
    try {
      const stats = await helperJson<TorrentStats>(`/stats/${encodeURIComponent(added.id)}`, { method: 'GET' })
      currentStats = stats
      onStats?.(stats)
    } catch { /* stats are best effort */ }
  }
  onStats?.(currentStats)
  const statsTimer = window.setInterval(() => { void refreshStats() }, 1_000)

  return {
    name: added.name,
    magnet,
    files,
    subtitleFiles,
    stats: () => currentStats,
    select: async (path) => {
      const file = files.find((candidate) => candidate.path === path)
      if (!file) throw new Error('torrent file not found')
      selectedIndex = file.index
      // Focus the swarm on this one file, in order, so its start arrives first.
      await helperJson(`/select`, { method: 'POST', body: JSON.stringify({ id: added.id, fileIndex: selectedIndex }) })
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.clearInterval(statsTimer)
      // Best effort: let the helper forget the torrent this tab opened.
      void fetch(`${HELPER_ORIGIN}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: added.id }),
        keepalive: true,
      }).catch(() => undefined)
    },
  }
}
