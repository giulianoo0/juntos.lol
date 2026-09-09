/**
 * Screen sharing over MoQ. A publisher's browser encodes the picked surface
 * with WebCodecs and publishes it to a Cloudflare relay; every viewer
 * subscribes to that publisher's path and decodes it onto a canvas. The relay
 * does the fan-out, so the VPS carries no media and holds no session: it only
 * hands out the relay URL with the token a member's role allows, plus the
 * broadcast base only this room knows.
 *
 * Several members can share at once, one broadcast path each, so the room's
 * list of live screens — not the relay — is what tells a viewer which paths
 * exist. The relay keeps no history and announces nothing, so a subscription
 * made before its publisher is up is dead on arrival: viewers subscribe when
 * the room says a screen is live, and try again while they see no frames.
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
/** Two seconds of GOP: a late viewer waits at most that long for its first picture. */
const KEYFRAME_INTERVAL_MS = 2_000 as NonNullable<Publish.Video.Config['keyframeInterval']>
/**
 * Bits per pixel per nominal frame the encoder is allowed to ask for. Set well
 * above what any preset needs, whichever codec is picked, so the ceiling we
 * compute below is what binds rather than the encoder's own formula.
 */
const BITRATE_SCALE = 0.2
/** A surface smaller than its preset still gets this much, so a tiny window is not starved. */
const MIN_BITRATE = 2_000_000

/** Whether this browser can carry a screen either way: QUIC to the relay and codecs in both directions. */
export function screenShareSupported(): boolean {
  return typeof WebTransport !== 'undefined'
    && typeof VideoEncoder !== 'undefined'
    && typeof VideoDecoder !== 'undefined'
}

export type ScreenQualityId = 'auto' | '1080p30' | '1080p60' | '1440p60' | '2160p30' | '2160p60'

/**
 * One rung of the quality picker. `maxBitrate` is a real ceiling in bits per
 * second, sized for screen content at that resolution and frame rate — a 4K60
 * film needs tens of megabits, and asking for less is what turns a sharp
 * screen into mush.
 */
export interface ScreenQuality {
  id: ScreenQualityId
  /** Technical label, the same in every language; `auto` is the one a UI may want to translate. */
  label: string
  width?: number
  height?: number
  frameRate?: number
  maxBitrate?: number
}

export const SCREEN_QUALITIES: readonly ScreenQuality[] = [
  { id: 'auto', label: 'auto' },
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 },
  { id: '1080p60', label: '1080p · 60 fps', width: 1920, height: 1080, frameRate: 60, maxBitrate: 10_000_000 },
  { id: '1440p60', label: '1440p · 60 fps', width: 2560, height: 1440, frameRate: 60, maxBitrate: 18_000_000 },
  { id: '2160p30', label: '4K · 30 fps', width: 3840, height: 2160, frameRate: 30, maxBitrate: 26_000_000 },
  { id: '2160p60', label: '4K · 60 fps', width: 3840, height: 2160, frameRate: 60, maxBitrate: 45_000_000 },
]

export const DEFAULT_SCREEN_QUALITY: ScreenQualityId = 'auto'

const QUALITY_STORAGE_KEY = 'ss.screen-quality.v1'

export function screenQuality(id: ScreenQualityId): ScreenQuality {
  return SCREEN_QUALITIES.find((quality) => quality.id === id) ?? SCREEN_QUALITIES[0]
}

export function loadScreenQuality(): ScreenQualityId {
  try {
    const stored = localStorage.getItem(QUALITY_STORAGE_KEY)
    if (stored && SCREEN_QUALITIES.some((quality) => quality.id === stored)) return stored as ScreenQualityId
  } catch { /* a browser with storage shut off still gets to share */ }
  return DEFAULT_SCREEN_QUALITY
}

export function saveScreenQuality(id: ScreenQualityId): void {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, id) } catch { /* nothing to do */ }
}

/**
 * The picker's constraints. A chosen rung is asked for as both ideal and max:
 * ideal is what makes the browser hand over a 4K60 surface at all, and max
 * keeps it from handing over a 5K one we would only spend CPU shrinking.
 */
function displayConstraints(quality: ScreenQuality): MediaTrackConstraints {
  if (!quality.width || !quality.height || !quality.frameRate) return {}
  return {
    width: { ideal: quality.width, max: quality.width },
    height: { ideal: quality.height, max: quality.height },
    frameRate: { ideal: quality.frameRate, max: quality.frameRate },
  }
}

/**
 * Must be called from inside the click: browsers require live user activation
 * and Firefox drops it after a single await, so nothing may be awaited first.
 *
 * Audio is always asked for; the picker's own checkbox decides whether it
 * comes. A tab always offers its sound, a whole screen offers the system's
 * where the OS allows it, and the rest offer none.
 */
export function requestScreenStream(qualityId: ScreenQualityId = loadScreenQuality()): Promise<MediaStream> {
  const options: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: displayConstraints(screenQuality(qualityId)),
    audio: true,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  }
  return navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
    // A shared screen is usually a film here, so smooth motion beats crisp text.
    for (const track of stream.getVideoTracks()) track.contentHint = 'motion'
    return stream
  })
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

/** Where a member reaches the room's screens: the relay with their token, and the paths. */
export interface ScreenRelay {
  url: string
  /** The prefix every screen of this room hangs off. */
  base: string
  /** This member's own broadcast path. */
  path: string
  /** Whether the token allows publishing. */
  publish: boolean
  /** Whether members other than the host may publish right now. */
  open: boolean
}

/** One member's broadcast path under a room's base. */
export function screenPath(base: string, memberId: string): string {
  return `${base}/${memberId}.hang`
}

export async function fetchScreenRelay(roomId: string, memberId: string, capability: string, publish = false): Promise<ScreenRelay> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, publish }),
  })
  if (!response.ok) throw new Error(response.status === 503 ? 'screenshare_disabled' : 'screenshare unavailable')
  return await response.json() as ScreenRelay
}

/** Puts this member on, or takes them off, the room's list of live screens. */
export async function setScreenLive(roomId: string, memberId: string, capability: string, live: boolean): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, live }),
    keepalive: true,
  })
  if (!response.ok) {
    // The server names its refusals; the caller tells them apart.
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? 'screenshare live flag rejected')
  }
}

/** The host's switch for whether anyone but them may share. */
export async function setScreenShareOpen(roomId: string, memberId: string, capability: string, open: boolean): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, open }),
  })
  if (!response.ok) throw new Error('screenshare open flag rejected')
}

function relayConnection(Net: typeof Publish.Net, url: string): Publish.Net.Connection.Reload {
  // The relay speaks QUIC only; racing a WebSocket it will never answer just delays the connect.
  return new Net.Connection.Reload({ url: new URL(url), enabled: true, websocket: { enabled: false }, delay: RELAY_RETRY })
}

/**
 * The concrete codec strings the publisher itself probes, in the order we want
 * them tried. Hardware H.264 is the one encoder that exists on every machine
 * that can push 4K60 at all, and the one decoder every viewer has; the rest
 * are fallbacks for the platforms that lack it.
 */
const CODEC_CANDIDATES = ['avc1.640028', 'hev1.1.6.L93.B0', 'vp09.00.10.08', 'av01.0.08M.08'] as const

/**
 * Which codec family can actually take this size and frame rate in hardware.
 * The publisher only filters its own candidates by the prefix we hand back, so
 * probing the same strings it would probe keeps our answer and its answer the
 * same one.
 */
async function preferredCodec(width: number, height: number, framerate: number, bitrate: number): Promise<string | undefined> {
  for (const codec of CODEC_CANDIDATES) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec, width, height, framerate, bitrate,
        latencyMode: 'realtime',
        hardwareAcceleration: 'prefer-hardware',
        ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' as const } } : {}),
        ...(codec.startsWith('hev1') ? { hevc: { format: 'annexb' as const } } : {}),
      })
      if (supported) return codec.split('.')[0]
    } catch { /* an unknown codec string is just a no */ }
  }
  return undefined
}

/**
 * The encoder knobs a preset comes down to. `maxPixels` and `frameRate` are
 * what keep 4K60 from being quietly downscaled — left unset, the encoder sizes
 * itself off the track's constraints — and `maxBitrate` doubles as the switch
 * that takes the connection's own estimate out of the decision, so a dip in
 * the uplink costs smoothness instead of collapsing the resolution.
 */
async function encoderConfig(quality: ScreenQuality, source: MediaStreamTrack): Promise<Publish.Video.Config> {
  const settings = source.getSettings()
  // The surface is what is really being sent: a 720p tab under a 4K preset
  // gets 720p's bitrate, not 4K's, or a modest uplink would drown.
  const width = Math.min(quality.width ?? Infinity, settings.width ?? quality.width ?? 1920)
  const height = Math.min(quality.height ?? Infinity, settings.height ?? quality.height ?? 1080)
  const frameRate = quality.frameRate ?? settings.frameRate ?? 30
  const maxBitrate = quality.maxBitrate && quality.width && quality.height
    ? Math.max(MIN_BITRATE, Math.round(quality.maxBitrate * (width * height) / (quality.width * quality.height)))
    : undefined
  return {
    codec: await preferredCodec(width, height, frameRate, maxBitrate ?? 8_000_000),
    keyframeInterval: KEYFRAME_INTERVAL_MS,
    bitrateScale: BITRATE_SCALE,
    ...(quality.width && quality.height ? { maxPixels: width * height } : {}),
    ...(quality.frameRate ? { frameRate: quality.frameRate } : {}),
    ...(maxBitrate ? { maxBitrate } : {}),
  }
}

/** What is really going out right now, for the readout under the stage. */
export interface ScreenSendStats {
  width: number
  height: number
  /** Measured over the last sample, not the target. */
  frameRate: number
  /** Bits per second, measured over the last sample. */
  bitrate: number
}

export interface ScreenPublisher {
  status: Publish.Signals.Getter<Publish.Net.Connection.ReloadStatus>
  /**
   * Resolves once the broadcast is on the relay. Only then may the room be
   * told this member is live: a viewer that subscribes earlier finds no track.
   */
  ready: Promise<void>
  /** Re-sizes and re-rates a live share in place, surface and encoder both. */
  setQuality(id: ScreenQualityId): Promise<void>
  /** Samples what the encoder is actually producing; returns null until it has. */
  sample(): ScreenSendStats | null
  close(): void
}

/** Encodes the stream's tracks and publishes them under the relay path until closed. */
export async function publishScreen(relay: ScreenRelay, stream: MediaStream, qualityId: ScreenQualityId): Promise<ScreenPublisher> {
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
  let quality = screenQuality(qualityId)
  const config = new Signals.Signal<Publish.Video.Config | undefined>(await encoderConfig(quality, videoTrack))
  // Switching to another window mid-share changes the surface's size; the
  // bitrate follows it.
  const onSurfaceChange = () => { void encoderConfig(quality, videoTrack).then((next) => config.set(next)).catch(() => undefined) }
  videoTrack.addEventListener('configurationchange', onSurfaceChange)
  const video = new Publish.Video.Encoder('video', { broadcast, capture, enabled: true, bandwidth, config })
  const audio = new Publish.Audio.Encoder('audio', {
    broadcast,
    enabled: audioTrack !== undefined,
    source: audioTrack ? { track: audioTrack as Publish.Audio.StreamTrack, kind: 'music' } : undefined,
    codec: { mime: 'opus', bitrate: SCREEN_AUDIO_BITRATE },
  })

  // Only a preset without a bitrate of its own lets the link decide: the
  // encoder falls back to the session's estimate when no ceiling is set, so a
  // thin uplink costs quality instead of stalling everyone.
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

  let last: { frames: number; bytes: number; at: number } | null = null

  return {
    status: connection.status,
    ready,
    async setQuality(id) {
      quality = screenQuality(id)
      // The surface has to grow before the encoder is told it may: a track
      // still handing over 1080p frames would only be re-encoded, not resized.
      await videoTrack.applyConstraints(displayConstraints(quality)).catch(() => undefined)
      config.set(await encoderConfig(quality, videoTrack))
      last = null
    },
    sample() {
      const resolved = video.out.resolved.peek()
      const stats = video.out.stats.peek()
      const at = performance.now()
      const previous = last
      last = { frames: stats.frames, bytes: stats.bytes, at }
      if (!resolved || !previous || at - previous.at < 250) return null
      const seconds = (at - previous.at) / 1000
      return {
        width: resolved.width,
        height: resolved.height,
        frameRate: (stats.frames - previous.frames) / seconds,
        bitrate: ((stats.bytes - previous.bytes) * 8) / seconds,
      }
    },
    close() {
      videoTrack.removeEventListener('configurationchange', onSurfaceChange)
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

/** Subscribes to one publisher's path and paints it on the canvas, with the audio on the speakers, until closed. */
export async function watchScreen(relay: ScreenRelay, path: string, canvas: HTMLCanvasElement, muted = false): Promise<ScreenWatcher> {
  const Watch = await import('@moq/watch')
  const { Net, Signals } = Watch

  const connection = relayConnection(Net, relay.url)
  const broadcast = new Watch.Broadcast({ connection: connection.established, enabled: true, name: Net.Path.from(path) })
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
  const mutedSignal = new Signals.Signal(muted)
  const emitter = new Watch.Audio.Emitter(audio, { volume: 1, muted: mutedSignal, paused: false })
  const renderer = new Watch.Video.Renderer(video, { canvas, visible: 'always' })

  // Audio is only downloaded while something can play it.
  const signals = new Signals.Effect()
  signals.proxy(audioEnabled, emitter.out.enabled)

  return {
    status: broadcast.out.status,
    muted: mutedSignal,
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
