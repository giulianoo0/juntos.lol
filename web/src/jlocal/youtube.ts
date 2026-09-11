/**
 * The companion app as a YouTube backend: yt-dlp and FFmpeg on the host's
 * own machine, publishing into the room's bucket with the claim this tab
 * obtains. The app runs one FFmpeg per region; this tab is its
 * orchestrator, so a seek outside what was produced becomes a new run here,
 * the way the server does it for the fleet.
 */
import { JLOCAL_ORIGIN, getJLocalSnapshot } from './status'
import { registerRemuxHandle, unregisterRemuxHandle } from '../upload'
import { YoutubeError, type YoutubeBackend, type YoutubeCapacity, type YoutubeSession, type YoutubeSummary } from '../youtube'

const PROBE_TIMEOUT_MS = 2500
const RESOLVE_TIMEOUT_MS = 150_000
const FOLLOW_AHEAD_MS = 45_000
const FOLLOW_BEHIND_MS = 1_000
const FOLLOW_DEBOUNCE_MS = 3_000
const POLL_MS = 2_000
const MAX_RETRIES = 1
const FAIL_COOLDOWN_MS = 30_000

export type JlocalToolsStatus =
  | { status: 'unsupported' }
  | { status: 'missing' }
  | { status: 'downloading'; done: number; total: number }
  | { status: 'ready' }
  | { status: 'failed'; error: string }

function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

/** The tools' state as the app reports it; null when the app is not there. */
export async function jlocalToolsStatus(): Promise<JlocalToolsStatus | null> {
  if (!getJLocalSnapshot().connected) return null
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/youtube/tools`, { signal: withTimeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    return await response.json() as JlocalToolsStatus
  } catch {
    return null
  }
}

/** Asks the app to fetch yt-dlp and FFmpeg; the status then moves through downloading. */
export async function installJlocalTools(): Promise<JlocalToolsStatus | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/youtube/tools`, { method: 'POST', signal: withTimeout(PROBE_TIMEOUT_MS) })
    return await response.json() as JlocalToolsStatus
  } catch {
    return null
  }
}

interface RunState {
  runId: string
  region: number
  startMs: number
  producedMs: number
  state: string
  retries: number
}

/**
 * One room's production on the app: the runs it started, and the follow
 * that turns an uncovered position into the next region.
 */
class JlocalProduction {
  private runs: RunState[] = []
  private last = 0
  private pending: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private stopped = false
  /** After a region failed twice, follows wait this long before trying again. */
  private cooldownUntil = 0

  private readonly session: YoutubeSession
  private readonly roomId: string
  private readonly mediaGeneration: number
  private readonly claim: string

  constructor(session: YoutubeSession, roomId: string, mediaGeneration: number, claim: string) {
    this.session = session
    this.roomId = roomId
    this.mediaGeneration = mediaGeneration
    this.claim = claim
  }

  async start(region: number, startMs: number, retries = 0): Promise<string | null> {
    const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    // The room's run fence must name this run before the app publishes under
    // it; the server moves the fence itself only for the fleet.
    try {
      const fence = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/client-media/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim: this.claim, runId }),
      })
      if (!fence.ok) return `run fence refused: ${fence.status}`
    } catch (error) {
      return `run fence failed: ${error instanceof Error ? error.message : String(error)}`
    }
    try {
      const response = await fetch(`${JLOCAL_ORIGIN}/youtube/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: this.session.url,
          runId,
          claim: this.claim,
          roomId: this.roomId,
          mediaGeneration: this.mediaGeneration,
          region,
          startMs,
          apiBase: window.location.origin,
        }),
      })
      if (response.status !== 202) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        return `jlocal refused the run (${response.status}${body.error ? ` ${body.error}` : ''})`
      }
    } catch (error) {
      return `jlocal run request failed: ${error instanceof Error ? error.message : String(error)}`
    }
    for (const run of this.runs) if (run.state === 'accepted' || run.state === 'running' || run.state === 'draining') run.state = 'superseded'
    this.runs.push({ runId, region, startMs, producedMs: 0, state: 'accepted', retries })
    if (this.poll === null) this.poll = setInterval(() => { void this.refresh() }, POLL_MS)
    return null
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return
    const live = this.runs.filter((run) => !['completed', 'cancelled', 'failed', 'superseded'].includes(run.state))
    for (const run of live) {
      try {
        const response = await fetch(`${JLOCAL_ORIGIN}/youtube/run/${encodeURIComponent(run.runId)}`, { signal: withTimeout(PROBE_TIMEOUT_MS) })
        if (response.status === 404) { run.state = 'failed'; continue }
        if (!response.ok) continue
        const body = await response.json() as { state: string; producedMs: number; error?: string | null }
        run.state = body.state
        run.producedMs = body.producedMs
        if (body.state === 'failed') {
          console.error('jlocal youtube run failed', run.runId, body.error)
          if (run.retries < MAX_RETRIES) void this.start(run.region, run.startMs, run.retries + 1)
          else this.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS
        }
      } catch {}
    }
  }

  private covered(positionMs: number): boolean {
    for (const run of this.runs) {
      if (run.state === 'failed' || run.state === 'cancelled') continue
      const end = run.startMs + run.producedMs
      const forward = run.state === 'completed' || run.state === 'superseded' ? end : end + FOLLOW_AHEAD_MS
      if (positionMs >= run.startMs - FOLLOW_BEHIND_MS && positionMs <= forward) return true
    }
    return false
  }

  /** The room's authoritative position moved; mirrors the server's Follow. */
  follow(positionMs: number): void {
    if (this.stopped || positionMs < 0) return
    const since = Date.now() - this.last
    if (since < FOLLOW_DEBOUNCE_MS) {
      this.pending = positionMs
      if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null
          const pending = this.pending
          this.pending = null
          if (pending !== null) this.follow(pending)
        }, FOLLOW_DEBOUNCE_MS - since)
      }
      return
    }
    this.last = Date.now()
    this.pending = null
    if (this.covered(positionMs) || Date.now() < this.cooldownUntil) return
    const region = this.runs.reduce((top, run) => Math.max(top, run.region), 0) + 1
    void this.start(region, positionMs).then((refusal) => {
      if (refusal) console.error('jlocal youtube follow refused', refusal)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.poll !== null) clearInterval(this.poll)
    for (const run of this.runs) {
      if (['completed', 'cancelled', 'failed', 'superseded'].includes(run.state)) continue
      void fetch(`${JLOCAL_ORIGIN}/youtube/run/${encodeURIComponent(run.runId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
    }
  }
}

const productions = new Map<string, JlocalProduction>()

export const jlocalBackend: YoutubeBackend = {
  name: 'jlocal',
  async capacity(): Promise<YoutubeCapacity> {
    const tools = await jlocalToolsStatus()
    return tools?.status === 'ready' ? 'available' : 'disabled'
  },
  async resolve(url) {
    let response: Response
    try {
      response = await fetch(`${JLOCAL_ORIGIN}/youtube/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: withTimeout(RESOLVE_TIMEOUT_MS),
      })
    } catch (error) {
      throw new YoutubeError('failed', `jlocal resolve failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.json().catch(() => ({})) as { summary?: YoutubeSummary; error?: string; detail?: string }
    if (!response.ok || !body.summary) {
      const code = body.error ?? ''
      if (code === 'tools_missing' || code === 'unsupported') throw new YoutubeError('no_workers')
      if (code === 'invalid_url') throw new YoutubeError('invalid')
      if (code.startsWith('youtube_')) throw new YoutubeError(code, body.detail)
      throw new YoutubeError('failed', body.detail ?? code ?? `status ${response.status}`)
    }
    return { url, videoId: body.summary.videoId, summary: body.summary, backend: 'jlocal', destroy: () => undefined }
  },
  async start(session, { roomId, mediaGeneration }) {
    // The claim is this tab's, exactly as for a file it would remux itself.
    let claim: string
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/client-media/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) return `client media claim refused: ${response.status}`
      const body = await response.json() as { claim: string; mediaGeneration: number }
      if (body.mediaGeneration !== mediaGeneration) return 'client media claim raced a source swap'
      claim = body.claim
    } catch (error) {
      return `client media claim failed: ${error instanceof Error ? error.message : String(error)}`
    }
    productions.get(roomId)?.stop()
    const production = new JlocalProduction(session, roomId, mediaGeneration, claim)
    const refusal = await production.start(0, 0)
    if (refusal !== null) return refusal
    productions.set(roomId, production)
    const handle = { follow: (absoluteMs: number) => production.follow(absoluteMs) }
    registerRemuxHandle(roomId, handle, () => {
      production.stop()
      if (productions.get(roomId) === production) productions.delete(roomId)
      unregisterRemuxHandle(roomId, handle)
    })
    return null
  },
}
