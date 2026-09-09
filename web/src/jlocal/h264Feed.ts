import { JLOCAL_ORIGIN } from './status'

/**
 * The companion's hardware H.264 path: jlocal captures the screen with
 * ScreenCaptureKit, encodes it on the media engine and streams Annex-B access
 * units over loopback. Nothing here decodes or re-encodes; the frames go to
 * the relay as they came.
 *
 * Wire format per frame: big-endian u32 payload length, u64 presentation
 * time in microseconds, one flag byte (bit 0 = keyframe), then the payload.
 */

export interface EncodedFrame {
  data: Uint8Array
  /** Microseconds, rebased so the first frame is near zero. */
  timestamp: number
  keyframe: boolean
}

export interface H264FeedOptions {
  target: { kind: 'display' | 'window'; id: string }
  width: number
  height: number
  fps: number
  bitrate?: number
}

export interface H264Feed {
  captureId: string | null
  width: number
  height: number
  fps: number
  bitrate: number
  /** Opens the frame stream; the first frame is always a keyframe. Returns the closer. */
  open(onFrame: (frame: EncodedFrame) => void, onEnd: () => void): () => void
  /** Ends capture on the app. Idempotent, never throws. */
  stop(): void
}

const HEADER_BYTES = 13

/** Reads the profile, constraints and level out of an SPS: `avc1.PPCCLL`. */
export function codecFromAnnexB(data: Uint8Array): string | null {
  for (let at = 0; at + 4 < data.length; at += 1) {
    if (data[at] !== 0 || data[at + 1] !== 0) continue
    const start = data[at + 2] === 1 ? at + 3 : data[at + 2] === 0 && data[at + 3] === 1 ? at + 4 : -1
    if (start < 0 || start + 4 > data.length) continue
    if ((data[start] & 0x1f) !== 7) continue
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`
  }
  return null
}

/** Splits a byte stream into frames; the parser keeps whatever a chunk boundary cut. */
export class FrameParser {
  private pending = new Uint8Array(0)
  private origin: number | null = null

  push(chunk: Uint8Array): EncodedFrame[] {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending, 0)
    merged.set(chunk, this.pending.length)
    const frames: EncodedFrame[] = []
    let at = 0
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength)
    while (merged.length - at >= HEADER_BYTES) {
      const length = view.getUint32(at)
      if (merged.length - at - HEADER_BYTES < length) break
      const pts = Number(view.getBigUint64(at + 4))
      const keyframe = (view.getUint8(at + 12) & 1) === 1
      if (this.origin === null) this.origin = pts
      frames.push({ data: merged.slice(at + HEADER_BYTES, at + HEADER_BYTES + length), timestamp: Math.max(0, pts - this.origin), keyframe })
      at += HEADER_BYTES + length
    }
    this.pending = merged.slice(at)
    return frames
  }
}

/** Asks the app to start capturing in H.264. Throws with the app's own reason. */
export async function startH264Feed(options: H264FeedOptions): Promise<H264Feed> {
  const idKey = options.target.kind === 'window' ? 'window_id' : 'display_id'
  let response: Response
  try {
    response = await fetch(`${JLOCAL_ORIGIN}/capture/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [idKey]: options.target.id, width: options.width, height: options.height, fps: options.fps, codec: 'h264', ...(options.bitrate ? { bitrate: options.bitrate } : {}) }),
    })
  } catch {
    throw new Error('jlocal-capture-unavailable')
  }
  const body = await response.json().catch(() => ({})) as { error?: string; capture_id?: string | number; width?: number; height?: number; fps?: number; bitrate?: number }
  if (!response.ok) {
    if (response.status === 503 && body.error === 'permission') throw new Error('jlocal-capture-permission')
    throw new Error(body.error ? `jlocal-capture-failed: ${body.error}` : 'jlocal-capture-unavailable')
  }
  const captureId = body.capture_id !== undefined ? String(body.capture_id) : null
  let stopped = false
  return {
    captureId,
    width: body.width ?? options.width,
    height: body.height ?? options.height,
    fps: body.fps ?? options.fps,
    bitrate: body.bitrate ?? options.bitrate ?? 0,
    open(onFrame, onEnd) {
      const controller = new AbortController()
      void (async () => {
        try {
          const stream = await fetch(`${JLOCAL_ORIGIN}/capture/h264`, { signal: controller.signal })
          if (!stream.ok || !stream.body) { onEnd(); return }
          const reader = stream.body.getReader()
          const parser = new FrameParser()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (const frame of parser.push(value)) onFrame(frame)
          }
        } catch { /* aborted or the app went away */ }
        if (!controller.signal.aborted) onEnd()
      })()
      return () => controller.abort()
    },
    stop() {
      if (stopped) return
      stopped = true
      try {
        void fetch(`${JLOCAL_ORIGIN}/capture/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(captureId ? { capture_id: captureId } : {}),
          keepalive: true,
        }).catch(() => undefined)
      } catch { /* nothing else to release */ }
    },
  }
}

const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_CHANNELS = 2
const AUDIO_FRAME_SAMPLES = 960
const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2

export interface SystemAudio {
  track: MediaStreamTrack
  stop(): void
}

/**
 * The app's system-audio mix as a track the publisher can encode: raw
 * s16le 48 kHz stereo from `GET /audio/stream`, scheduled gapless into a
 * MediaStreamAudioDestination. The track exists before the first byte
 * arrives, so it can be handed to the publisher right away; a missing app
 * or an unwired platform just leaves it silent.
 */
export function systemAudioTrack(): SystemAudio | null {
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const AudioCtor = scope.AudioContext ?? scope.webkitAudioContext
  if (!AudioCtor) return null
  let context: AudioContext
  try {
    context = new AudioCtor({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'playback' })
  } catch {
    return null
  }
  const destination = context.createMediaStreamDestination()
  const [track] = destination.stream.getAudioTracks()
  if (!track) { void context.close().catch(() => undefined); return null }
  const controller = new AbortController()
  void (async () => {
    await context.resume().catch(() => undefined)
    let response: Response
    try {
      response = await fetch(`${JLOCAL_ORIGIN}/audio/stream`, { signal: controller.signal })
    } catch {
      return
    }
    if (!response.ok || !response.body) return
    const reader = response.body.getReader()
    let pending = new Uint8Array(0)
    let nextStart = context.currentTime
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || controller.signal.aborted) break
        const merged = new Uint8Array(pending.length + value.length)
        merged.set(pending, 0)
        merged.set(value, pending.length)
        pending = merged
        while (pending.length >= AUDIO_FRAME_BYTES) {
          const frame = pending.subarray(0, AUDIO_FRAME_BYTES)
          pending = pending.slice(AUDIO_FRAME_BYTES)
          const buffer = context.createBuffer(AUDIO_CHANNELS, AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE)
          const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
          for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
            const samples = buffer.getChannelData(channel)
            for (let i = 0; i < AUDIO_FRAME_SAMPLES; i += 1) samples[i] = view.getInt16((i * AUDIO_CHANNELS + channel) * 2, true) / 32768
          }
          const node = context.createBufferSource()
          node.buffer = buffer
          node.connect(destination)
          const when = Math.max(nextStart, context.currentTime)
          node.start(when)
          nextStart = when + AUDIO_FRAME_SAMPLES / AUDIO_SAMPLE_RATE
        }
      }
    } catch { /* the app went away; the track goes quiet */ }
  })()
  return {
    track,
    stop() {
      controller.abort()
      track.stop()
      void context.close().catch(() => undefined)
    },
  }
}

/**
 * Paints the feed onto a canvas with WebCodecs, for the publisher's own
 * preview tile. Opens its own frame stream; the app fans out to any number.
 */
export function previewH264(feed: H264Feed, canvas: HTMLCanvasElement): () => void {
  if (typeof VideoDecoder === 'undefined') return () => undefined
  const context = canvas.getContext('2d')
  if (!context) return () => undefined
  canvas.width = feed.width
  canvas.height = feed.height
  const decoder = new VideoDecoder({
    output: (frame) => {
      context.drawImage(frame, 0, 0, canvas.width, canvas.height)
      frame.close()
    },
    error: () => undefined,
  })
  let configured = false
  const close = feed.open((frame) => {
    if (!configured) {
      if (!frame.keyframe) return
      const codec = codecFromAnnexB(frame.data) ?? 'avc1.640028'
      try {
        decoder.configure({ codec, codedWidth: feed.width, codedHeight: feed.height, optimizeForLatency: true })
      } catch {
        return
      }
      configured = true
    }
    if (decoder.state !== 'configured') return
    try {
      decoder.decode(new EncodedVideoChunk({ type: frame.keyframe ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data }))
    } catch { /* a frame the decoder refused is just skipped */ }
  }, () => undefined)
  return () => {
    close()
    try { decoder.close() } catch { /* already closed */ }
  }
}
