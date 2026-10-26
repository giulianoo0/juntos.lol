/**
 * Cameras and microphones over the same MoQ relay as the screens. Each member
 * publishes one broadcast, `{base}/av/{memberId}.hang`, carrying a small
 * camera picture and their voice, and everyone else subscribes to it. The
 * relay does the fan-out; the server only hands out the paths and tokens.
 *
 * Voice runs at the relay's real-time latency, not the screens' quarter
 * second floor: measured mouth to ear through the Cloudflare relay it lands
 * around 140 ms (p90 under 200 ms; see `dev/e2e-call-latency.mjs`).
 */
import type * as Publish from '@moq/publish'
import type * as Watch from '@moq/watch'
import { relayConnection, watchConnection, whenPublished } from './moq'
import { rms } from './speaking'
import type { WatchStatus } from './subscriptions'

/** Where a member reaches the room's cameras and voices. */
export interface CallRelay {
  /** The relay with the subscribe token. */
  url: string
  /** The relay with the publish token: every member may send their own camera and voice. */
  publishUrl: string
  /** The WebSocket way onto the same broadcasts, for WebKit. Read-only; may be relative. */
  bridge?: string
  base: string
  /** This member's own broadcast path. */
  path: string
}

/** One member's camera and voice under a room's base. */
export function callPath(base: string, memberId: string): string {
  return `${base}/av/${memberId}.hang`
}

export async function fetchCallRelay(roomId: string, memberId: string, capability: string): Promise<CallRelay> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/call/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability }),
  })
  if (!response.ok) throw new Error(response.status === 503 ? 'call_disabled' : 'call unavailable')
  return await response.json() as CallRelay
}

/** A camera tile is small: 360p is plenty, and keeps a dozen of them inside a modest downlink. */
const CAM_WIDTH = 640
const CAM_HEIGHT = 360
const CAM_FRAME_RATE = 30
const CAM_MAX_BITRATE = 600_000
/** Opus for speech: mono at a rate that keeps a voice clear and costs next to nothing. */
const VOICE_BITRATE = 32_000
/** Two seconds of GOP: someone who turns up waits at most that long for a face. */
const KEYFRAME_INTERVAL_MS = 2_000 as NonNullable<Publish.Video.Config['keyframeInterval']>

export function micConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  }
}

export function camConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    width: { ideal: CAM_WIDTH },
    height: { ideal: CAM_HEIGHT },
    frameRate: { ideal: CAM_FRAME_RATE, max: CAM_FRAME_RATE },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  }
}

export async function openMic(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
  return stream.getAudioTracks()[0]
}

export async function openCam(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(deviceId) })
  const [track] = stream.getVideoTracks()
  track.contentHint = 'motion'
  return track
}

export interface CallPublisher {
  /** Resolves once the broadcast is on the relay. */
  ready: Promise<void>
  /** Sends this microphone, or stops sending voice when given nothing. */
  setMic(track: MediaStreamTrack | undefined): void
  /** Sends this camera, or stops sending pictures when given nothing. */
  setCam(track: MediaStreamTrack | undefined): void
  close(): void
}

/**
 * Publishes this member's broadcast. It stays on the relay for the whole call
 * with whatever is switched on, so viewers keep one subscription and simply
 * see the catalog gain or lose a track.
 */
export async function publishCall(relay: CallRelay): Promise<CallPublisher> {
  const Publish = await import('@moq/publish')
  const { Net, Signals } = Publish
  const connection = relayConnection(Net, relay.publishUrl)
  const videoSource = new Signals.Signal<Publish.Video.Source | undefined>(undefined)
  const videoEnabled = new Signals.Signal(false)
  const audioSource = new Signals.Signal<Publish.Audio.Source | undefined>(undefined)
  const audioEnabled = new Signals.Signal(false)
  const capture = new Publish.Video.Capture({ source: videoSource })
  const broadcast = new Publish.Broadcast({
    connection: connection.established,
    enabled: true,
    name: Net.Path.from(relay.path),
    display: capture.out.display,
  })
  const video = new Publish.Video.Encoder('video', {
    broadcast,
    capture,
    enabled: videoEnabled,
    config: {
      keyframeInterval: KEYFRAME_INTERVAL_MS,
      maxPixels: CAM_WIDTH * CAM_HEIGHT,
      frameRate: CAM_FRAME_RATE,
      maxBitrate: CAM_MAX_BITRATE,
    },
  })
  const audio = new Publish.Audio.Encoder('audio', {
    broadcast,
    enabled: audioEnabled,
    source: audioSource,
    codec: { mime: 'opus', bitrate: VOICE_BITRATE },
  })
  return {
    ready: whenPublished(broadcast),
    setMic(track) {
      audioSource.set(track ? { track: track as Publish.Audio.StreamTrack, kind: 'voice' } : undefined)
      audioEnabled.set(track !== undefined)
    },
    setCam(track) {
      videoSource.set(track as Publish.Video.Source | undefined)
      videoEnabled.set(track !== undefined)
    },
    close() {
      audio.close()
      video.close()
      broadcast.close()
      capture.close()
      connection.close()
    },
  }
}

/** One member's broadcast as a viewer holds it: their voice always, their camera while a tile shows it. */
export interface MemberWatch {
  status: { peek(): WatchStatus; subscribe(listener: (status: WatchStatus) => void): () => void }
  /** Paints the camera on this canvas while it is on screen, or stops when given null. */
  setCanvas(canvas: HTMLCanvasElement | null): void
  /** Plays the voice, or stops downloading it. */
  setAudio(enabled: boolean): void
  setVolume(volume: number): void
  /** RMS of the voice as it reaches the speakers right now, 0 when silent. */
  level(): number
  /** Media time of the last voice sample played, to tell a stalled voice from a quiet one. */
  audioAt(): number | undefined
  /** Drops the voice's subscription and opens a fresh one after a short gap, keeping the rest. */
  reopenAudio(): void
  close(): void
}

/**
 * The way onto the relay for every member's broadcast. Each member gets a
 * connection of their own: on a shared one, a subscription the relay turned
 * away kept every later one to the same broadcast stuck waiting.
 */
export interface CallWatchSession {
  watch(memberId: string): MemberWatch
  /** Plays every voice on this output device, where the browser lets a page choose. */
  setSpeaker(deviceId: string | undefined): void
  close(): void
}

/** How long a reopened voice waits for the relay to finish tearing the old subscription down. */
const RESUBSCRIBE_GAP_MS = 1_500

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

export async function openCallWatch(relay: CallRelay): Promise<CallWatchSession> {
  const Watch = await import('@moq/watch')
  const { Net, Signals } = Watch
  const contexts = new Set<SinkContext>()
  let speaker: string | undefined

  const watch = (memberId: string): MemberWatch => {
    const connection = watchConnection(Net, relay)
    const broadcast = new Watch.Broadcast({ connection: connection.established, enabled: true, name: Net.Path.from(callPath(relay.base, memberId)) })
    const videoSource = new Watch.Video.Source({ broadcast, supported: Watch.Video.Decoder.supported })
    const audioSource = new Watch.Audio.Source({ broadcast, supported: Watch.Audio.Decoder.supported })
    // A call is a conversation: the smallest buffer the relay's round trip allows.
    const sync = new Watch.Sync({
      latency: 'real-time',
      connection: connection.established,
      video: videoSource.out.jitter,
      audio: audioSource.out.jitter,
    })
    const canvas = new Signals.Signal<HTMLCanvasElement | undefined>(undefined)
    const videoEnabled = new Signals.Signal(false)
    const videoDecoder = new Watch.Video.Decoder(videoSource, sync, { enabled: videoEnabled, paced: true })
    // Only a tile that is on screen downloads its camera.
    const renderer = new Watch.Video.Renderer(videoDecoder, { canvas, visible: '0px' })
    const audioWanted = new Signals.Signal(false)
    const volume = new Signals.Signal(1)
    const samples = new Float32Array(512)
    const signals = new Signals.Effect()
    signals.run((effect) => {
      const rendering = effect.get(canvas) !== undefined && effect.get(renderer.out.visible)
      videoEnabled.set(rendering)
    })

    // The voice holds its own subscription and AudioContext, so it can start
    // over on its own while the broadcast and the camera keep going.
    let audio: { decoder: Watch.Audio.Decoder; analyser: () => AnalyserNode | null } | null = null
    const openAudio = () => {
      const enabled = new Signals.Signal(false)
      const decoder = new Watch.Audio.Decoder(audioSource, sync, { enabled })
      const emitter = new Watch.Audio.Emitter(decoder, { volume, muted: false, paused: false })
      let analyser: AnalyserNode | null = null
      const wiring = new Signals.Effect()
      wiring.run((effect) => {
        enabled.set(effect.get(audioWanted) && effect.get(emitter.out.enabled))
      })
      wiring.run((effect) => {
        const context = effect.get(decoder.out.context) as SinkContext | undefined
        const root = effect.get(decoder.out.root)
        if (!context || !root) return
        contexts.add(context)
        if (speaker) void context.setSinkId?.(speaker).catch(() => undefined)
        const node = context.createAnalyser()
        node.fftSize = samples.length
        root.connect(node)
        analyser = node
        effect.cleanup(() => {
          contexts.delete(context)
          try { root.disconnect(node) } catch { /* the graph is already gone */ }
          if (analyser === node) analyser = null
        })
      })
      audio = { decoder, analyser: () => analyser }
      return () => {
        audio = null
        wiring.close()
        emitter.close()
        decoder.close()
      }
    }
    let closeAudio = openAudio()
    let reopening: ReturnType<typeof setTimeout> | null = null
    return {
      status: broadcast.out.status,
      setCanvas(next) { canvas.set(next ?? undefined) },
      setAudio(enabled) { audioWanted.set(enabled) },
      setVolume(next) { volume.set(next) },
      audioAt() { return audio?.decoder.out.timestamp.peek() },
      reopenAudio() {
        if (reopening !== null) return
        closeAudio()
        closeAudio = () => undefined
        reopening = setTimeout(() => {
          reopening = null
          closeAudio = openAudio()
        }, RESUBSCRIBE_GAP_MS)
      },
      level() {
        const analyser = audio?.analyser()
        if (!analyser || !audioWanted.peek()) return 0
        analyser.getFloatTimeDomainData(samples)
        return rms(samples)
      },
      close() {
        if (reopening !== null) clearTimeout(reopening)
        signals.close()
        closeAudio()
        renderer.close()
        videoDecoder.close()
        sync.close()
        audioSource.close()
        videoSource.close()
        broadcast.close()
        connection.close()
      },
    }
  }

  return {
    watch,
    setSpeaker(deviceId) {
      speaker = deviceId
      for (const context of contexts) void context.setSinkId?.(deviceId ?? '').catch(() => undefined)
    },
    close() { /* each member's watch closes its own connection */ },
  }
}

/** Measures my own microphone, for my own ring: what I send is what the others hear. */
export function localLevel(track: MediaStreamTrack): { level(): number; close(): void } {
  const context = new AudioContext()
  const source = context.createMediaStreamSource(new MediaStream([track]))
  const analyser = context.createAnalyser()
  const samples = new Float32Array(512)
  analyser.fftSize = samples.length
  source.connect(analyser)
  return {
    level() {
      analyser.getFloatTimeDomainData(samples)
      return rms(samples)
    },
    close() {
      source.disconnect()
      void context.close().catch(() => undefined)
    },
  }
}

