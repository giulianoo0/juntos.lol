/**
 * A room produced by the companion app: FFmpeg on the host's own machine,
 * publishing into the room's bucket with the claim this tab obtains. The app
 * runs one FFmpeg per region; this tab is its orchestrator, so a seek outside
 * what was produced becomes a new run here, the way the server does it for
 * the fleet.
 */
import { JLOCAL_ORIGIN } from './status'
import { registerRemuxHandle, unregisterRemuxHandle } from '../upload'

const PROBE_TIMEOUT_MS = 2500
const FOLLOW_AHEAD_MS = 45_000
const FOLLOW_BEHIND_MS = 1_000
const FOLLOW_DEBOUNCE_MS = 3_000
const POLL_MS = 2_000
const MAX_RETRIES = 1
const FAIL_COOLDOWN_MS = 30_000

/** Which of the app's run endpoints produces the room. */
export type JlocalSource = 'youtube' | 'torrent'

export function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
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

  private readonly source: JlocalSource
  private readonly input: Record<string, unknown>
  private readonly roomId: string
  private readonly mediaGeneration: number
  private readonly claim: string

  constructor(source: JlocalSource, input: Record<string, unknown>, roomId: string, mediaGeneration: number, claim: string) {
    this.source = source
    this.input = input
    this.roomId = roomId
    this.mediaGeneration = mediaGeneration
    this.claim = claim
  }

  private runUrl(runId?: string): string {
    const base = `${JLOCAL_ORIGIN}/${this.source}/run`
    return runId === undefined ? base : `${base}/${encodeURIComponent(runId)}`
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
      const response = await fetch(this.runUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...this.input,
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
        const response = await fetch(this.runUrl(run.runId), { signal: withTimeout(PROBE_TIMEOUT_MS) })
        if (response.status === 404) { run.state = 'failed'; continue }
        if (!response.ok) continue
        const body = await response.json() as { state: string; producedMs: number; error?: string | null }
        run.state = body.state
        run.producedMs = body.producedMs
        if (body.state === 'failed') {
          console.error(`jlocal ${this.source} run failed`, run.runId, body.error)
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
      if (refusal) console.error(`jlocal ${this.source} follow refused`, refusal)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.poll !== null) clearInterval(this.poll)
    for (const run of this.runs) {
      if (['completed', 'cancelled', 'failed', 'superseded'].includes(run.state)) continue
      void fetch(this.runUrl(run.runId), { method: 'DELETE', keepalive: true }).catch(() => undefined)
    }
  }
}

const productions = new Map<string, JlocalProduction>()

/**
 * Claims the room's media as this tab, starts region 0 on the app and hands
 * the room's follow to it. Resolves null on an accepted handoff, or with the
 * reason it was refused.
 */
export async function startJlocalProduction(
  source: JlocalSource,
  input: Record<string, unknown>,
  roomId: string,
  mediaGeneration: number,
): Promise<string | null> {
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
  const production = new JlocalProduction(source, input, roomId, mediaGeneration, claim)
  const refusal = await production.start(0, 0)
  if (refusal !== null) {
    // Give the reservation back, or the fleet taking over is refused as a conflict.
    await fetch(`/api/rooms/${encodeURIComponent(roomId)}/client-media?claim=${encodeURIComponent(claim)}`, { method: 'DELETE' }).catch(() => undefined)
    return refusal
  }
  productions.set(roomId, production)
  const handle = { follow: (absoluteMs: number) => production.follow(absoluteMs) }
  registerRemuxHandle(roomId, handle, () => {
    production.stop()
    if (productions.get(roomId) === production) productions.delete(roomId)
    unregisterRemuxHandle(roomId, handle)
  })
  return null
}
