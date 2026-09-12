/**
 * A YouTube live as a room source. Nothing is prepared into the bucket: a
 * producer copies the live's stream onto the MoQ relay, under the room's
 * screen-share secret, and every member watches the edge from there. The
 * producer is the host's companion app when it is here with its tools, and
 * a worker of the fleet otherwise.
 */
import { JLOCAL_ORIGIN, getJLocalSnapshot } from './jlocal/status'
import { jlocalToolsStatus } from './jlocal/youtube'
import { fetchScreenRelay } from './screenshare'
import { YoutubeError, canonicalYoutubeUrl, youtubeVideoId } from './youtube'

export interface LiveSource {
  url: string
  title: string
  thumbnail?: string | null
}

export interface LiveAuth {
  memberId: string
  capability: string
}

export type LiveProducer = 'fleet' | 'jlocal'

interface LiveStartResponse {
  status: string
  mediaGeneration: number
  broadcast: string
}

const JLOCAL_TIMEOUT_MS = 8000
const POLL_MS = 2000
/** What a producer says about the live itself holds for every producer. */
const FINAL_VERDICTS = ['youtube_unavailable', 'youtube_unsupported']

function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

async function askServer(roomId: string, auth: LiveAuth, source: LiveSource, producer: LiveProducer): Promise<LiveStartResponse> {
  const videoId = youtubeVideoId(source.url)
  if (!videoId) throw new YoutubeError('invalid')
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberId: auth.memberId,
      capability: auth.capability,
      url: canonicalYoutubeUrl(videoId),
      producer,
      title: source.title,
      thumbnail: source.thumbnail ?? '',
    }),
  })
  const body = await response.json().catch(() => ({})) as Partial<LiveStartResponse> & { error?: string }
  if (!response.ok) {
    const code = body.error ?? ''
    if (code === 'live_disabled') throw new YoutubeError('no_workers')
    throw new YoutubeError(code.startsWith('youtube_') || code === 'live_ended' ? code : 'failed', code || `status ${response.status}`)
  }
  if (typeof body.broadcast !== 'string') throw new YoutubeError('failed', 'live start without a broadcast')
  return body as LiveStartResponse
}

interface JlocalLiveState {
  state: 'starting' | 'live' | 'ended' | 'failed'
  code?: string
  detail?: string
}

/** One live the companion app keeps for a room, followed by this tab. */
class JlocalLive {
  private timer: ReturnType<typeof setInterval> | null = null
  private reported = ''
  private stopped = false
  private wasLive = false

  private readonly roomId: string
  private readonly auth: LiveAuth
  private readonly source: LiveSource

  constructor(roomId: string, auth: LiveAuth, source: LiveSource) {
    this.roomId = roomId
    this.auth = auth
    this.source = source
  }

  start(): void {
    this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return
    let state: JlocalLiveState
    try {
      const response = await fetch(`${JLOCAL_ORIGIN}/youtube/live/${encodeURIComponent(this.roomId)}`, { signal: withTimeout(JLOCAL_TIMEOUT_MS) })
      if (response.status === 404) state = { state: 'failed', code: 'youtube_tool', detail: 'the companion app lost the live' }
      else if (!response.ok) return
      else state = await response.json() as JlocalLiveState
    } catch {
      return
    }
    if (state.state === 'starting' || state.state === this.reported) return
    this.reported = state.state
    if (state.state === 'live') this.wasLive = true
    // The app failing before the live ever showed, for a reason that is not
    // about the live itself, is the fleet's turn: the same swap, the other producer.
    if (state.state === 'failed' && !this.wasLive && !FINAL_VERDICTS.includes(state.code ?? '')) {
      this.stop(false)
      jlocalLives.delete(this.roomId)
      console.warn('jlocal lost the live before it started; asking the fleet', state.code, state.detail)
      try {
        await askServer(this.roomId, this.auth, this.source, 'fleet')
        return
      } catch (error) {
        console.error('fleet refused the live too', error)
        state = { state: 'failed', code: error instanceof YoutubeError ? error.code : 'youtube_tool', detail: state.detail }
      }
    }
    try {
      await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/live/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: this.auth.memberId, capability: this.auth.capability, state: state.state, code: state.code ?? '', detail: state.detail ?? '' }),
      })
    } catch {
      this.reported = ''
    }
    if (state.state === 'ended' || state.state === 'failed') this.stop(false)
  }

  stop(tellApp = true): void {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (tellApp) {
      void fetch(`${JLOCAL_ORIGIN}/youtube/live/${encodeURIComponent(this.roomId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
    }
  }
}

const jlocalLives = new Map<string, JlocalLive>()

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const live of jlocalLives.values()) live.stop()
    jlocalLives.clear()
  })
}

/** Stops the companion app's live for a room, if this tab is following one. */
export function stopLive(roomId: string): void {
  const live = jlocalLives.get(roomId)
  if (!live) return
  jlocalLives.delete(roomId)
  live.stop()
}

async function jlocalReady(): Promise<boolean> {
  if (!getJLocalSnapshot().connected) return false
  const tools = await jlocalToolsStatus()
  return tools?.status === 'ready'
}

/**
 * Puts a live on the relay for a room this member controls. The companion
 * app goes first; when it is not here, has no tools, or turns the live
 * down, the fleet takes it. A verdict about the live itself is final.
 */
export async function startYoutubeLive(roomId: string, source: LiveSource, auth: LiveAuth): Promise<LiveProducer> {
  stopLive(roomId)
  if (await jlocalReady()) {
    const started = await askServer(roomId, auth, source, 'jlocal')
    const relay = await fetchScreenRelay(roomId, auth.memberId, auth.capability, true)
    let accepted = false
    if (relay.publish) {
      try {
        const response = await fetch(`${JLOCAL_ORIGIN}/youtube/live/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: source.url, relay: relay.url, broadcast: started.broadcast, roomId }),
          signal: withTimeout(JLOCAL_TIMEOUT_MS),
        })
        if (response.status === 202) {
          accepted = true
        } else {
          const body = await response.json().catch(() => ({})) as { error?: string; detail?: string }
          const code = body.error ?? ''
          // What the app says about the live itself holds for the fleet too.
          if (FINAL_VERDICTS.includes(code)) throw new YoutubeError(code, body.detail)
          console.warn('jlocal turned the live down; asking the fleet', code || response.status)
        }
      } catch (error) {
        if (error instanceof YoutubeError) throw error
        console.warn('jlocal live request failed; asking the fleet', error)
      }
    }
    if (accepted) {
      const live = new JlocalLive(roomId, auth, source)
      jlocalLives.set(roomId, live)
      live.start()
      return 'jlocal'
    }
  }
  await askServer(roomId, auth, source, 'fleet')
  return 'fleet'
}
