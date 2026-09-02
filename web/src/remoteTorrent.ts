/**
 * The page's side of the worker fleet. A magnet is registered with the
 * server, which places it on a worker and resolves its metadata in the
 * swarm; the page polls for the listing, selects one file, and receives a
 * `readBase` and a ticket — the only way it ever learns where the bytes
 * are. Reads then go straight to the worker over HTTPS Range; the server
 * is never in the byte path.
 */
import { isSubtitleFileName } from './subtitleFormats'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile, WorkerGrant } from './torrent'
import { ReadGate, rangeBytes } from './pipeline/rangeRead'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
const POLL_MS = 1_500
const STATS_MS = 2_000
const LISTING_TIMEOUT_MS = 150_000

/** No worker is enrolled, or the instance runs without any. Retryable later. */
export class NoWorkersError extends Error {
  constructor() {
    super('no torrent workers')
    this.name = 'NoWorkersError'
  }
}

/** Workers exist but every one of them is full. Retryable soon. */
export class WorkersBusyError extends Error {
  constructor() {
    super('torrent workers busy')
    this.name = 'WorkersBusyError'
  }
}

/** The server or the worker refused this torrent for good. */
export class TorrentRejectedError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`torrent rejected: ${code}`)
    this.name = 'TorrentRejectedError'
    this.code = code
  }
}

/** The session's own budget is spent for now. */
export class TorrentQuotaError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`torrent quota: ${reason}`)
    this.name = 'TorrentQuotaError'
    this.reason = reason
  }
}

export interface ParsedMagnet {
  infoHash: string
  trackers: string[]
  dn: string
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32ToHex(input: string): string | null {
  let bits = ''
  for (const ch of input.toUpperCase()) {
    const value = BASE32.indexOf(ch)
    if (value < 0) return null
    bits += value.toString(2).padStart(5, '0')
  }
  let hex = ''
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0')
  return hex.length === 40 ? hex : null
}

/** Pulls the infohash, trackers and name out of a magnet; null when it has no usable hash. */
export function parseMagnet(magnet: string): ParsedMagnet | null {
  const trimmed = magnet.trim()
  if (!trimmed.toLowerCase().startsWith('magnet:?')) return null
  const params = new URLSearchParams(trimmed.slice('magnet:?'.length))
  let infoHash: string | null = null
  for (const xt of params.getAll('xt')) {
    const match = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt)
    if (!match) continue
    infoHash = match[1].length === 40 ? match[1].toLowerCase() : base32ToHex(match[1])
    if (infoHash) break
  }
  if (!infoHash) return null
  return { infoHash, trackers: params.getAll('tr').slice(0, 20), dn: params.get('dn') ?? '' }
}

interface JobFile {
  index: number
  name: string
  path: string
  size: number
}

interface JobStatus {
  jobId: string
  state: string
  error?: string
  name?: string
  files?: JobFile[]
  swarm?: { peers: number; downSpeed: number; haveBytes: number; selectedBytes: number; diskBytes?: number }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/torrents${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let code = ''
    let reason = ''
    try {
      const body = await response.json() as { error?: string; reason?: string }
      code = body.error ?? ''
      reason = body.reason ?? ''
    } catch {}
    throw classify(response.status, code, reason)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

function classify(status: number, code: string, reason: string): Error {
  if (code === 'no_workers') return new NoWorkersError()
  if (code === 'workers_busy' || code === 'worker_gone') return new WorkersBusyError()
  if (status === 429) return new TorrentQuotaError(reason || code || 'rate_limited')
  if (code === 'blocked' || code === 'not_video' || code === 'no_metadata' || code === 'invalid_infohash') {
    return new TorrentRejectedError(code)
  }
  return new Error(`torrent api ${code || status}`)
}

/** available, busy, no_workers or disabled. */
export async function torrentCapacity(): Promise<string> {
  try {
    const response = await fetch('/api/torrents/capacity')
    if (!response.ok) return 'disabled'
    const body = await response.json() as { capacity?: string }
    return body.capacity ?? 'disabled'
  } catch {
    return 'available'
  }
}

export interface FleetMember {
  id: string
  version?: string
  availability: 'available' | 'busy' | 'draining' | 'offline'
  /** Lease and disk pressure as one number in 0..1, the one placement sorts by. */
  load: number
  leases: number
  maxLeases?: number
  torrents: number
  maxTorrents?: number
  diskUsed: number
  // What the volume actually carries; diskUsed is the reservation admission
  // counts on, not the bytes on disk.
  diskReal?: number
  diskQuota?: number
  transferUsedBps: number
  transferCapBps?: number
  uptimeSecs?: number
  lastSeenSecs: number
}

export interface Fleet {
  capacity: string
  /** Best for this viewer first, ordered the way the server would place a room. */
  workers: FleetMember[]
}

/** Rooms with someone in them right now. */
export interface Live {
  rooms: number
  members: number
}

// Counted from the live WebSocket connections, not from stored rooms: a room
// key outlives the tab that made it by the whole room TTL.
export async function liveNow(): Promise<Live> {
  const response = await fetch('/api/live')
  if (!response.ok) throw new Error(`live ${response.status}`)
  const body = await response.json() as Partial<Live>
  return { rooms: body.rooms ?? 0, members: body.members ?? 0 }
}

export async function fleetStatus(): Promise<Fleet> {
  const response = await fetch('/api/fleet')
  if (!response.ok) throw new Error(`fleet ${response.status}`)
  const body = await response.json() as Partial<Fleet>
  return { capacity: body.capacity ?? 'disabled', workers: body.workers ?? [] }
}

export interface WorkerProbe {
  id: string
  readBase: string
  /** The worker already holds this torrent's pieces on disk. */
  holds: boolean
  state: 'testing' | 'ok' | 'down'
  mbit?: number
  ttfbMs?: number
  chosen?: boolean
}

const PROBE_BYTES = 3 * 1024 * 1024
const PROBE_BUDGET_MS = 6_000
// Enough of a transfer to rank by: past this, the probe only makes the person
// opening the room wait longer.
const PROBE_ENOUGH_BYTES = 1024 * 1024
const PROBE_ENOUGH_MS = 400
const RANKING_TTL_MS = 3 * 60_000

// Reachability, first byte and throughput over up to three megabytes or six
// seconds, whichever ends first.
async function probeOne(target: { id: string; readBase: string; holds: boolean; probe: string }): Promise<WorkerProbe> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_BUDGET_MS)
  const t0 = performance.now()
  try {
    const response = await fetch(`${target.probe}?bytes=${PROBE_BYTES}`, { signal: abort.signal })
    if (!response.ok || !response.body) throw new Error(String(response.status))
    const firstByteAt = performance.now()
    const ttfbMs = Math.round(firstByteAt - t0)
    const reader = response.body.getReader()
    let received = 0
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      received += value?.byteLength ?? 0
      if (received >= PROBE_ENOUGH_BYTES && performance.now() - firstByteAt >= PROBE_ENOUGH_MS) {
        abort.abort()
        break
      }
    }
    // From the first byte, not from the request: the round trip is already
    // the ttfb this returns, and counting it twice punishes a distant path.
    const seconds = (performance.now() - firstByteAt) / 1000
    if (received === 0 || seconds <= 0) throw new Error('empty probe')
    return {
      id: target.id,
      readBase: target.readBase,
      holds: target.holds,
      state: 'ok',
      ttfbMs,
      mbit: Math.round(received * 8 / seconds / 1e6 * 10) / 10,
    }
  } catch {
    return { id: target.id, readBase: target.readBase, holds: target.holds, state: 'down' }
  } finally {
    clearTimeout(timer)
  }
}

// Reachable beats unreachable, then measured speed decides; holding the
// pieces is only a multiplier, not a veto.
const HOLDS_BONUS = 1.5
function rankProbes(probes: WorkerProbe[]): WorkerProbe[] {
  const score = (p: WorkerProbe) => (p.mbit ?? 0) * (p.holds ? HOLDS_BONUS : 1)
  const ranked = [...probes].sort((a, b) => {
    if ((a.state === 'ok') !== (b.state === 'ok')) return a.state === 'ok' ? -1 : 1
    return score(b) - score(a)
  })
  return ranked.map((p, i) => ({ ...p, chosen: i === 0 && p.state === 'ok' }))
}

const rankings = new Map<string, { at: number; probes: WorkerProbe[] }>()

/**
 * Reports progressively through `onProbe` and resolves with the ranking, best
 * first. A recent ranking is reused unless a fresh measurement is asked for.
 */
export async function probeWorkers(
  infoHash: string,
  onProbe?: (probes: WorkerProbe[]) => void,
  options?: { fresh?: boolean },
): Promise<WorkerProbe[]> {
  const remembered = rankings.get(infoHash)
  if (!options?.fresh && remembered && Date.now() - remembered.at < RANKING_TTL_MS
    && remembered.probes.some((p) => p.state === 'ok')) {
    onProbe?.(remembered.probes)
    return remembered.probes
  }
  let targets: { id: string; readBase: string; holds: boolean; probe: string }[]
  try {
    const body = await api<{ workers: { id: string; readBase: string; holds: boolean; probe: string }[] | null }>(
      `/workers?infoHash=${encodeURIComponent(infoHash)}`,
    )
    targets = body.workers ?? []
  } catch {
    return []
  }
  let current: WorkerProbe[] = targets.map((t) => ({ id: t.id, readBase: t.readBase, holds: t.holds, state: 'testing' as const }))
  onProbe?.(current)
  await Promise.all(targets.map(async (target) => {
    const result = await probeOne(target)
    current = current.map((p) => (p.id === result.id ? result : p))
    onProbe?.(current.some((p) => p.state === 'testing') ? current : rankProbes(current))
  }))
  const ranked = rankProbes(current)
  rankings.set(infoHash, { at: Date.now(), probes: ranked })
  onProbe?.(ranked)
  return ranked
}

export interface OpenTorrentOptions {
  onProbe?: (probes: WorkerProbe[]) => void
}

/**
 * Registers a magnet and waits for the worker's listing; the session reads
 * bytes from the worker directly. Every worker is measured from this browser
 * first and the ranking rides along with the dispatch.
 */
export async function openRemoteTorrent(
  magnet: string,
  onStats?: (stats: TorrentStats) => void,
  options?: OpenTorrentOptions,
): Promise<TorrentSession> {
  const parsed = parseMagnet(magnet)
  if (!parsed) throw new TorrentRejectedError('invalid_infohash')
  const probes = await probeWorkers(parsed.infoHash, options?.onProbe)
  const preferred = probes.filter((p) => p.state === 'ok').map((p) => p.id)
  const started = await api<{ jobId: string }>('', {
    method: 'POST',
    body: JSON.stringify({ infoHash: parsed.infoHash, trackers: parsed.trackers, dn: parsed.dn, preferred }),
  })
  const jobId = started.jobId
  const gate = new ReadGate()
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    gate.close()
    if (statsTimer !== null) clearInterval(statsTimer)
    void fetch(`/api/torrents/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
  }

  const deadline = Date.now() + LISTING_TIMEOUT_MS
  let status: JobStatus
  while (true) {
    status = await api<JobStatus>(`/${encodeURIComponent(jobId)}`)
    if (status.state === 'listed') break
    if (status.state === 'failed') {
      destroy()
      throw classify(502, status.error ?? 'failed', '')
    }
    if (Date.now() > deadline) {
      destroy()
      throw new Error('torrent listing timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }

  let grant: WorkerGrant | null = null
  const readOpts = () => {
    if (!grant) throw new Error('torrent file not selected')
    return {
      url: () => `${grant!.readBase}/v1/f/${grant!.ticket}?prio=head`,
      size: grant.size,
      gate,
      refresh: async () => {
        const next = await api<WorkerGrant>(`/${encodeURIComponent(jobId)}/token`, { method: 'POST' })
        grant = { ...grant!, ...next }
        return true
      },
    }
  }

  const files = (status.files ?? [])
    .filter((file) => VIDEO_EXTENSION.test(file.name))
    .map((file): TorrentVideoFile => ({
      name: file.name,
      path: file.path,
      index: file.index,
      size: file.size,
      type: 'application/octet-stream',
      get progress() { return currentStats.progress },
      get downloaded() { return currentStats.downloaded },
      get worker() { return grant && grant.fileIndex === file.index ? grant : undefined },
      read: async (start, endInclusive) => {
        if (destroyed) throw new Error('torrent session closed')
        const bytes = await rangeBytes(readOpts(), start, endInclusive + 1)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    }))
    .sort((a, b) => b.size - a.size)

  const subtitleFiles = (status.files ?? [])
    .filter((file) => isSubtitleFileName(file.name) && file.size > 0 && file.size <= MAX_SIDE_FILE_BYTES)
    .map((file): TorrentSideFile => ({
      name: file.name,
      path: file.path,
      size: file.size,
      index: file.index,
      get streamUrl() { return grant ? `${grant.readBase}/v1/file/${grant.ticket}/${file.index}` : undefined },
      read: async () => {
        if (!grant) throw new Error('torrent file not selected')
        const response = await fetch(`${grant.readBase}/v1/file/${grant.ticket}/${file.index}`)
        if (!response.ok) throw new Error(`sidecar read failed (${response.status})`)
        return await response.arrayBuffer()
      },
    }))

  let currentStats: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }
  const refreshStats = async () => {
    try {
      const next = await api<JobStatus>(`/${encodeURIComponent(jobId)}?only=swarm`)
      if (!next.swarm) return
      const total = Math.max(next.swarm.selectedBytes, 1)
      currentStats = {
        peers: next.swarm.peers,
        downloadSpeed: next.swarm.downSpeed,
        downloaded: next.swarm.haveBytes,
        diskBytes: next.swarm.diskBytes,
        progress: Math.min(next.swarm.haveBytes / total, 1),
      }
      onStats?.(currentStats)
    } catch {}
  }
  onStats?.(currentStats)
  if (onStats) statsTimer = setInterval(() => { void refreshStats() }, STATS_MS)

  return {
    name: status.name ?? parsed.dn ?? 'torrent',
    magnet,
    jobId,
    files,
    subtitleFiles,
    stats: () => currentStats,
    select: async (path) => {
      const file = files.find((candidate) => candidate.path === path)
      if (!file) throw new Error('torrent file not found')
      const next = await api<WorkerGrant>(`/${encodeURIComponent(jobId)}/select`, {
        method: 'POST',
        body: JSON.stringify({ fileIndex: file.index }),
      })
      grant = { ...next, jobId }
      if (statsTimer === null) statsTimer = setInterval(() => { void refreshStats() }, STATS_MS)
    },
    abortReads: () => gate.abort(),
    destroy,
    detach: () => {
      // No DELETE: the job now feeds the worker's own remux.
      if (destroyed) return
      destroyed = true
      gate.close()
      if (statsTimer !== null) clearInterval(statsTimer)
    },
  }
}
