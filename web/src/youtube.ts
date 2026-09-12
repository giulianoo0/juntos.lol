/**
 * A YouTube link as a room source. The page never touches YouTube itself:
 * its CDN answers only youtube.com and binds every stream URL to the address
 * that resolved it. A backend resolves the link and produces the room —
 * the fleet's worker (through the server) or the host's companion app — and
 * this module hides which one, so the room flow is the torrent's.
 */

export type YoutubeCapacity = 'available' | 'busy' | 'no_workers' | 'disabled'

export interface YoutubeSummary {
  videoId: string
  title: string
  durationMs: number
  thumbnail: string | null
  video: { itag: string; codec: string; width: number; height: number }
  audios: { itag: string; codec: string; language: string; original: boolean }[]
  subtitles: { language: string; title: string; auto: boolean }[]
  chapters: number
  /** A live: no duration, no seek; it goes to the relay instead of the bucket. */
  live?: boolean
}

/** A resolved link, ready to become a room; `start` hands the production over. */
export interface YoutubeSession {
  url: string
  videoId: string
  summary: YoutubeSummary
  backend: 'fleet' | 'jlocal'
  /** The fleet job behind the session, when the fleet resolved it. */
  jobId?: string
  destroy: () => void
}

export interface YoutubeAuth {
  memberId: string
  capability: string
}

export interface YoutubeStart {
  roomId: string
  mediaGeneration: number
  ownerToken?: string
  auth?: YoutubeAuth
}

/** One way of turning a link into a room. */
export interface YoutubeBackend {
  readonly name: 'fleet' | 'jlocal'
  capacity(): Promise<YoutubeCapacity>
  resolve(url: string): Promise<YoutubeSession>
  /** Resolves null on an accepted handoff, or with the reason it was refused. */
  start(session: YoutubeSession, start: YoutubeStart): Promise<string | null>
}

export class YoutubeError extends Error {
  readonly code: string
  constructor(code: string, detail = '') {
    super(detail || code)
    this.name = 'YoutubeError'
    this.code = code
  }
}

export function isYoutubeError(error: unknown): error is YoutubeError {
  return error instanceof YoutubeError
}

/** The 11-character video id, from the link shapes people paste; null otherwise. */
export function youtubeVideoId(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 2048) return null
  let parsed: URL
  try {
    parsed = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let id = ''
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '')
  if (host === 'youtu.be') {
    id = path
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (path === 'watch') id = parsed.searchParams.get('v') ?? ''
    else if (/^(shorts|live|embed|v)\//.test(path)) id = path.slice(path.indexOf('/') + 1)
    else return null
  } else {
    return null
  }
  id = id.split(/[/?&#]/)[0]
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
}

export function isYoutubeLink(raw: string): boolean {
  return youtubeVideoId(raw) !== null
}

export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

const POLL_MS = 1500
const RESOLVE_TIMEOUT_MS = 150_000

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/youtube${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; reason?: string }
    throw classify(response.status, body.error ?? '', body.reason ?? '')
  }
  return await response.json() as T
}

function classify(status: number, code: string, reason: string): YoutubeError {
  if (status === 429) return new YoutubeError('quota', reason || code)
  if (code === 'no_youtube' || code === 'no_workers' || code === 'disabled') return new YoutubeError('no_workers')
  if (code === 'workers_busy') return new YoutubeError('busy')
  if (code === 'invalid_url') return new YoutubeError('invalid')
  if (code.startsWith('youtube_')) return new YoutubeError(code)
  return new YoutubeError('failed', code || `status ${status}`)
}

/** What the page says for each way a link can fail to open. */
export function youtubeErrorKey(error: unknown): string {
  if (!(error instanceof YoutubeError)) return 'home.youtubeFailed'
  switch (error.code) {
    case 'invalid': return 'home.youtubeInvalid'
    case 'no_workers': return 'home.youtubeNoWorkers'
    case 'busy': return 'home.youtubeBusy'
    case 'quota': return 'home.youtubeQuota'
    case 'youtube_blocked': return 'home.youtubeBlocked'
    case 'youtube_unavailable': return 'home.youtubeUnavailable'
    case 'youtube_no_workers': return 'home.youtubeNoWorkers'
    case 'youtube_busy': return 'home.youtubeBusy'
    case 'live_ended': return 'room.liveEnded'
    case 'youtube_unsupported': return 'home.youtubeUnsupported'
    default: return 'home.youtubeFailed'
  }
}

/** A link the backend refused for good is not worth retrying on resume. */
export function youtubeErrorRetryable(error: unknown): boolean {
  if (!(error instanceof YoutubeError)) return true
  return !['invalid', 'youtube_unavailable', 'youtube_unsupported'].includes(error.code)
}

interface JobStatus {
  jobId: string
  state: 'resolving' | 'listed' | 'failed'
  url: string
  error?: string
  summary?: YoutubeSummary
}

/** The fleet: the server dispatches the link to a worker with yt-dlp. */
export const fleetBackend: YoutubeBackend = {
  name: 'fleet',
  async capacity() {
    try {
      const response = await fetch('/api/youtube/capacity')
      if (!response.ok) return 'disabled'
      const body = await response.json() as { capacity?: string }
      return (body.capacity as YoutubeCapacity | undefined) ?? 'disabled'
    } catch {
      return 'disabled'
    }
  },
  async resolve(url) {
    const videoId = youtubeVideoId(url)
    if (!videoId) throw new YoutubeError('invalid')
    const started = await api<{ jobId: string }>('', { method: 'POST', body: JSON.stringify({ url: canonicalYoutubeUrl(videoId) }) })
    const jobId = started.jobId
    let destroyed = false
    const destroy = () => {
      if (destroyed) return
      destroyed = true
      void fetch(`/api/youtube/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
    }
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS
    while (true) {
      const status = await api<JobStatus>(`/${encodeURIComponent(jobId)}`)
      if (status.state === 'listed' && status.summary) {
        return { url: canonicalYoutubeUrl(videoId), videoId, summary: status.summary, backend: 'fleet', jobId, destroy }
      }
      if (status.state === 'failed') {
        destroy()
        throw classify(502, status.error ?? 'failed', '')
      }
      if (Date.now() > deadline) {
        destroy()
        throw new YoutubeError('failed', 'resolve timed out')
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  },
  async start(session, { roomId, mediaGeneration, ownerToken, auth }) {
    if (!session.jobId) return 'youtube session has no fleet job'
    if (!ownerToken && !auth) return 'no proof of ownership for the room'
    try {
      const response = await fetch(`/api/youtube/${encodeURIComponent(session.jobId)}/remux`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          mediaGeneration,
          requestId: crypto.randomUUID(),
          startMs: 0,
          auth: ownerToken ? { ownerToken } : auth,
        }),
      })
      if (response.status === 202) return null
      const body = await response.json().catch(() => ({})) as { error?: string }
      return `remux refused (${response.status}${body.error ? ` ${body.error}` : ''})`
    } catch (error) {
      return `remux request failed: ${error instanceof Error ? error.message : String(error)}`
    }
  },
}

let backends: YoutubeBackend[] = [fleetBackend]

/** The backends in the order they are tried; the companion app registers itself first. */
export function registerYoutubeBackend(backend: YoutubeBackend): void {
  backends = [backend, ...backends.filter((b) => b.name !== backend.name)]
}

export function youtubeBackends(): YoutubeBackend[] {
  return backends
}

export function backendFor(session: YoutubeSession): YoutubeBackend {
  const backend = backends.find((b) => b.name === session.backend)
  if (!backend) throw new YoutubeError('failed', `backend ${session.backend} is gone`)
  return backend
}

/** The best capacity any backend reports. */
export async function youtubeCapacity(): Promise<YoutubeCapacity> {
  const rank: YoutubeCapacity[] = ['available', 'busy', 'no_workers', 'disabled']
  const all = await Promise.all(backends.map((b) => b.capacity()))
  return all.reduce((best, next) => (rank.indexOf(next) < rank.indexOf(best) ? next : best), 'disabled' as YoutubeCapacity)
}

/**
 * Resolves the link with the first backend that has room. A backend saying
 * it has no workers lets the next one try; a verdict about the video itself
 * (private, live, blocked) is final.
 */
export async function openYoutube(url: string): Promise<YoutubeSession> {
  if (!youtubeVideoId(url)) throw new YoutubeError('invalid')
  let last: unknown = new YoutubeError('no_workers')
  for (const backend of backends) {
    const capacity = await backend.capacity()
    if (capacity === 'disabled' || capacity === 'no_workers') {
      last = new YoutubeError('no_workers')
      continue
    }
    try {
      return await backend.resolve(url)
    } catch (error) {
      last = error
      if (error instanceof YoutubeError && ['no_workers', 'busy', 'failed', 'youtube_blocked'].includes(error.code)) continue
      throw error
    }
  }
  throw last
}
