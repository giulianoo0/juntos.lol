/**
 * Screen sharing over MoQ. The host's browser encodes the picked surface with
 * WebCodecs and publishes it to a Cloudflare relay; every viewer subscribes to
 * the same broadcast path and decodes it onto a canvas. The relay does the
 * fan-out, so the VPS carries no media and holds no session: it only hands
 * out the relay URL with the token a member's role allows, plus the path only
 * this room knows.
 *
 * The relay keeps no history and announces nothing, so a subscription made
 * before the host publishes is dead on arrival. The room's `screenLive` flag,
 * which the host sets through the server, is what tells a viewer when to
 * subscribe, and when to try again.
 */
import type * as Publish from '@moq/publish'
import type * as Watch from '@moq/watch'

const pendingStreams = new Map<string, MediaStream>()

/** Opus for a film soundtrack, not a voice call: stereo at a rate that keeps music intact. */
const SCREEN_AUDIO_BITRATE = 160_000
/** How often the publisher asks the relay session what it can carry. */
const BANDWIDTH_PROBE_MS = 500
/** The reconnect loop never gives up on its own; leaving the room is what stops it. */
const RELAY_RETRY = { initial: 1000, multiplier: 2, max: 5000, timeout: 0 }
/** How long a publisher may take to get its broadcast onto the relay before sharing counts as failed. */
const PUBLISH_READY_MS = 15_000

/** Whether this browser can carry a screen either way: QUIC to the relay and codecs in both directions. */
export function screenShareSupported(): boolean {
  return typeof WebTransport !== 'undefined'
    && typeof VideoEncoder !== 'undefined'
    && typeof VideoDecoder !== 'undefined'
}

/**
 * Must be called from inside the click: browsers require live user activation
 * and Firefox drops it after a single await, so nothing may be awaited first.
 *
 * Audio is always asked for; the picker's own checkbox decides whether it
 * comes. A tab always offers its sound, a whole screen offers the system's
 * where the OS allows it, and the rest offer none.
 */
export function requestScreenStream(): Promise<MediaStream> {
  const options: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: true,
    audio: true,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  }
  return navigator.mediaDevices.getDisplayMedia(options)
}

export function stashScreenStream(roomID: string, stream: MediaStream): void {
  pendingStreams.get(roomID)?.getTracks().forEach((track) => track.stop())
  pendingStreams.set(roomID, stream)
}

export function takeScreenStream(roomID: string): MediaStream | null {
  const stream = pendingStreams.get(roomID) ?? null
  pendingStreams.delete(roomID)
  return stream
}

export function dropScreenStream(roomID: string): void {
  takeScreenStream(roomID)?.getTracks().forEach((track) => track.stop())
}

export function isScreenShareCancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

/** Where a member reaches the room's screen: the relay with their token, and the broadcast path. */
export interface ScreenRelay {
  url: string
  path: string
  /** Whether the token allows publishing; only the controller's does. */
  publish: boolean
}

export async function fetchScreenRelay(roomId: string, memberId: string, capability: string): Promise<ScreenRelay> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability }),
  })
  if (!response.ok) throw new Error(response.status === 503 ? 'screenshare_disabled' : 'screenshare unavailable')
  return await response.json() as ScreenRelay
}

/** Tells the room whether the host is publishing, which is what viewers subscribe on. */
export async function setScreenLive(roomId: string, memberId: string, capability: string, live: boolean): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, live }),
    keepalive: true,
  })
  if (!response.ok) throw new Error('screenshare live flag rejected')
}

function relayConnection(Net: typeof Publish.Net, url: string): Publish.Net.Connection.Reload {
  // The relay speaks QUIC only; racing a WebSocket it will never answer just delays the connect.
  return new Net.Connection.Reload({ url: new URL(url), enabled: true, websocket: { enabled: false }, delay: RELAY_RETRY })
}

export interface ScreenPublisher {
  status: Publish.Signals.Getter<Publish.Net.Connection.ReloadStatus>
  /**
   * Resolves once the broadcast is on the relay. Only then may the room be
   * told the host is live: a viewer that subscribes earlier finds no track.
   */
  ready: Promise<void>
  close(): void
}

/** Encodes the stream's tracks and publishes them under the relay path until closed. */
export async function publishScreen(relay: ScreenRelay, stream: MediaStream): Promise<ScreenPublisher> {
  const Publish = await import('@moq/publish')
  const { Net, Signals } = Publish
  const [videoTrack] = stream.getVideoTracks()
  const [audioTrack] = stream.getAudioTracks()
  if (!videoTrack) throw new Error('screen stream has no video track')

  const connection = relayConnection(Net, relay.url)
  const capture = new Publish.Video.Capture({ source: videoTrack as Publish.Video.Source })
  const broadcast = new Publish.Broadcast({
    connection: connection.established,
    enabled: true,
    name: Net.Path.from(relay.path),
    display: capture.out.display,
  })
  const bandwidth = new Signals.Signal<number | undefined>(undefined)
  const video = new Publish.Video.Encoder('video', { broadcast, capture, enabled: true, bandwidth })
  const audio = new Publish.Audio.Encoder('audio', {
    broadcast,
    enabled: audioTrack !== undefined,
    source: audioTrack ? { track: audioTrack as Publish.Audio.StreamTrack, kind: 'music' } : undefined,
    codec: { mime: 'opus', bitrate: SCREEN_AUDIO_BITRATE },
  })

  // The encoder caps its bitrate at what the session can carry, so a thin
  // uplink costs quality instead of stalling everyone.
  const signals = new Signals.Effect()
  signals.run((effect) => {
    const established = effect.get(connection.established)
    effect.set(bandwidth, undefined)
    if (!established) return
    let probing = false
    effect.interval(() => {
      if (probing) return
      probing = true
      void established.stats()
        .then((stats) => { if (stats) bandwidth.set(stats.estimatedSendRate) })
        .catch(() => undefined)
        .finally(() => { probing = false })
    }, BANDWIDTH_PROBE_MS)
  })

  const ready = new Promise<void>((resolve, reject) => {
    if (broadcast.net.peek()) { resolve(); return }
    const timer = setTimeout(() => {
      stop()
      reject(new Error('relay did not accept the broadcast in time'))
    }, PUBLISH_READY_MS)
    const stop = broadcast.net.subscribe((producer) => {
      if (!producer) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })

  return {
    status: connection.status,
    ready,
    close() {
      signals.close()
      audio.close()
      video.close()
      broadcast.close()
      capture.close()
      connection.close()
    },
  }
}

export type ScreenWatchStatus = 'offline' | 'loading' | 'live'

export interface ScreenWatcher {
  status: Watch.Signals.Getter<ScreenWatchStatus>
  muted: Watch.Signals.Signal<boolean>
  close(): void
}

/** Subscribes to the relay path and paints it on the canvas, with the audio on the speakers, until closed. */
export async function watchScreen(relay: ScreenRelay, canvas: HTMLCanvasElement): Promise<ScreenWatcher> {
  const Watch = await import('@moq/watch')
  const { Net, Signals } = Watch

  const connection = relayConnection(Net, relay.url)
  const broadcast = new Watch.Broadcast({ connection: connection.established, enabled: true, name: Net.Path.from(relay.path) })
  const videoSource = new Watch.Video.Source({ broadcast, supported: Watch.Video.Decoder.supported })
  const audioSource = new Watch.Audio.Source({ broadcast, supported: Watch.Audio.Decoder.supported })
  const sync = new Watch.Sync({
    latency: 'real-time',
    connection: connection.established,
    video: videoSource.out.jitter,
    audio: audioSource.out.jitter,
  })
  const video = new Watch.Video.Decoder(videoSource, sync, { enabled: true, paced: true })
  const audioEnabled = new Signals.Signal(false)
  const audio = new Watch.Audio.Decoder(audioSource, sync, { enabled: audioEnabled })
  const muted = new Signals.Signal(false)
  const emitter = new Watch.Audio.Emitter(audio, { volume: 1, muted, paused: false })
  const renderer = new Watch.Video.Renderer(video, { canvas, visible: 'always' })

  // Audio is only downloaded while something can play it.
  const signals = new Signals.Effect()
  signals.proxy(audioEnabled, emitter.out.enabled)

  return {
    status: broadcast.out.status,
    muted,
    close() {
      signals.close()
      renderer.close()
      emitter.close()
      audio.close()
      video.close()
      sync.close()
      audioSource.close()
      videoSource.close()
      broadcast.close()
      connection.close()
    },
  }
}
