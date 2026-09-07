import { JLOCAL_ORIGIN } from './status'

// Screen frames captured by the companion app, published through the existing
// browser MoQ pipeline. The app only captures: this module polls its latest
// JPEG onto a canvas and hands out canvas.captureStream(), which the feed
// module passes to stashScreenStream(roomID, stream) like any browser-picked
// surface. With opts.audio the feed also opens GET /audio/stream (infinite
// s16le 48kHz stereo PCM) and appends its decoded track to the same stream,
// so publishScreen picks it up untouched; without it the stream stays video.
export interface JLocalScreenFeedOptions {
  width: number
  height: number
  fps: number
  /** Open /audio/stream and append its track. Default false: existing callers stay video-only. */
  audio?: boolean
}

/**
 * What a confirm picked, remembered so a live share can reconfigure without
 * repicking: same target, new size/rate. qualityId is the panel's option id
 * (preset or the target's native size label).
 */
export interface JLocalFeedChoice {
  target: JLocalScreenTarget
  qualityId: string
  width: number
  height: number
  fps: number
  audio: boolean
}

// PCM contract: the server flushes ~20ms frames of s16le 48kHz stereo with
// no framing headers — a raw infinite body, so any chunk boundary can split
// a frame and the decoder below reassembles by byte count.
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const AUDIO_FRAME_SAMPLES = 960
const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2

const MJPEG_HEADER_END = new Uint8Array([13, 10, 13, 10])
const MAX_MJPEG_FRAME_BYTES = 16 * 1024 * 1024

/**
 * Chunk queue for the multipart stream. The old parser concatenated the
 * entire partial JPEG after every network read, turning a fragmented 4K
 * frame into quadratic copying on the browser main thread. This queue copies
 * headers (tiny) and each completed JPEG exactly once.
 */
class ByteQueue {
  private chunks: Uint8Array[] = []
  private headOffset = 0
  length = 0

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  indexOf(needle: Uint8Array): number {
    let matched = 0
    let index = 0
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex]
      const start = chunkIndex === 0 ? this.headOffset : 0
      for (let offset = start; offset < chunk.length; offset += 1) {
        const byte = chunk[offset]
        if (byte === needle[matched]) {
          matched += 1
          if (matched === needle.length) return index - needle.length + 1
        } else {
          matched = byte === needle[0] ? 1 : 0
        }
        index += 1
      }
    }
    return -1
  }

  take(count: number): Uint8Array | null {
    if (count < 0 || this.length < count) return null
    const out = new Uint8Array(count)
    let written = 0
    while (written < count) {
      const head = this.chunks[0]
      if (!head) return null
      const available = head.length - this.headOffset
      const copy = Math.min(available, count - written)
      out.set(head.subarray(this.headOffset, this.headOffset + copy), written)
      written += copy
      this.headOffset += copy
      this.length -= copy
      if (this.headOffset === head.length) {
        this.chunks.shift()
        this.headOffset = 0
      }
    }
    return out
  }

  clear(): void {
    this.chunks = []
    this.headOffset = 0
    this.length = 0
  }
}

/** Content-Length-driven multipart decoder matching jlocal's stream. */
class MjpegParser {
  private readonly bytes = new ByteQueue()
  private expectedBytes: number | null = null
  private readonly decoder = new TextDecoder()

  push(chunk: Uint8Array): Uint8Array[] {
    this.bytes.push(chunk)
    const frames: Uint8Array[] = []
    for (;;) {
      if (this.expectedBytes === null) {
        const headerEnd = this.bytes.indexOf(MJPEG_HEADER_END)
        if (headerEnd < 0) {
          if (this.bytes.length > 4096) this.bytes.clear()
          break
        }
        const header = this.bytes.take(headerEnd + MJPEG_HEADER_END.length)
        const match = header ? /content-length:\s*(\d+)/i.exec(this.decoder.decode(header)) : null
        const length = match ? Number(match[1]) : 0
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_MJPEG_FRAME_BYTES) {
          this.bytes.clear()
          break
        }
        this.expectedBytes = length
      }
      if (this.bytes.length < this.expectedBytes) break
      const frame = this.bytes.take(this.expectedBytes)
      this.expectedBytes = null
      if (frame) frames.push(frame)
    }
    return frames
  }
}

export interface JLocalScreenFeed {
  stream: MediaStream
  stop: () => void
}

/** Best-effort capture release. Never throws: stop() must not fail. */
function stopCapture(captureId: string | null): void {
  try {
    const init: RequestInit = captureId === null
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capture_id: captureId }),
        }
    Promise.resolve(fetch(`${JLOCAL_ORIGIN}/capture/stop`, init)).catch(() => {})
  } catch {
    // The fetch itself threw synchronously (no network stack in tests): the
    // companion app leaves nothing else to clean up.
  }
}
/**
 * Opens GET /audio/stream and decodes its infinite s16le body through an
 * AudioContext ending in a MediaStreamAudioDestination, whose track is
 * appended to the feed's stream. Returns the stop cleanup synchronously so
 * stop() works even while the fetch is still in flight.
 *
 * Never throws and never fails the feed: 404 (no capture session), 501
 * (unwired platform), a missing body, no AudioContext, or any network chop
 * all leave the stream video-only. The loop ends on stop(), reader cancel,
 * or a finished body; sources are scheduled back-to-back from the context
 * clock so frames play gapless.
 */
function startSystemAudio(stream: MediaStream, isStopped: () => boolean): () => void {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let context: AudioContext | null = null
  let cancelled = false

  function cleanup(): void {
    cancelled = true
    // Cancelling unblocks the pending read below, so the loop exits at once.
    try {
      void reader?.cancel().catch(() => {})
    } catch {
      // A closing reader must not break stop().
    }
    reader = null
    try {
      void context?.close().catch(() => {})
    } catch {
      // An already-closed context must not break stop().
    }
    context = null
  }

  void (async () => {
    let response: Response
    try {
      response = await fetch(`${JLOCAL_ORIGIN}/audio/stream`)
    } catch {
      return // App gone: the feed stays video-only.
    }
    if (!response.ok || !response.body) return
    if (cancelled || isStopped()) {
      try {
        await response.body.cancel()
      } catch {
        // Already torn down alongside stop(): nothing to release.
      }
      return
    }
    const scope = globalThis as unknown & {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const AudioCtor = scope.AudioContext ?? scope.webkitAudioContext
    if (!AudioCtor) return
    let audioContext: AudioContext
    try {
      audioContext = new AudioCtor({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'playback' })
    } catch {
      return
    }
    if (cancelled || isStopped()) {
      try {
        await audioContext.close().catch(() => {})
      } catch {
        // Raced with stop(): the cleanup above already ran.
      }
      return
    }
    context = audioContext
    // Autoplay policy boots the context suspended when creation escapes the
    // click gesture (the start POST + canvas setup run first): without an
    // explicit resume the clock never advances and every frame stays silent.
    try {
      await audioContext.resume().catch(() => {})
    } catch {
      // A closing context must not break the feed.
    }
    const destination = audioContext.createMediaStreamDestination()
    const [audioTrack] = destination.stream.getAudioTracks()
    if (!audioTrack) {
      cleanup()
      return
    }
    stream.addTrack(audioTrack)
    reader = response.body.getReader()
    let pending = new Uint8Array(0)
    // Next source start on the context clock; keeps frames gapless.
    let nextStart = audioContext.currentTime
    for (;;) {
      if (cancelled || isStopped()) break
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch {
        break // Mid-stream chop: video keeps going, audio just ends.
      }
      if (read.done) break
      const merged = new Uint8Array(pending.length + read.value.length)
      merged.set(pending, 0)
      merged.set(read.value, pending.length)
      pending = merged
      while (pending.length >= AUDIO_FRAME_BYTES) {
        if (cancelled || isStopped()) break
        const frame = pending.subarray(0, AUDIO_FRAME_BYTES)
        pending = pending.slice(AUDIO_FRAME_BYTES)
        let buffer: AudioBuffer
        try {
          buffer = audioContext.createBuffer(AUDIO_CHANNELS, AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE)
        } catch {
          break
        }
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
        for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
          const samples = buffer.getChannelData(channel)
          for (let i = 0; i < AUDIO_FRAME_SAMPLES; i += 1) {
            samples[i] = view.getInt16((i * AUDIO_CHANNELS + channel) * 2, true) / 32768
          }
        }
        try {
          const source = audioContext.createBufferSource()
          source.connect(destination)
          const when = Math.max(nextStart, audioContext.currentTime)
          source.start(when)
          nextStart = when + AUDIO_FRAME_SAMPLES / AUDIO_SAMPLE_RATE
        } catch {
          break // Context torn down mid-frame: stop() owns the rest.
        }
      }
    }
    if (!cancelled) cleanup()
  })()

  return cleanup
}

/**
 * Starts app-side capture for a display or a window and returns a live
 * MediaStream of its frames. Throws Error('jlocal-capture-unavailable') when
 * the app refuses or the canvas cannot be set up. Frame poll failures skip
 * that frame and keep polling; only stop() ends the loop. With opts.audio
 * the stream also carries the decoded /audio/stream track; audio failures
 * never throw — the stream just stays video-only.
 */
export interface JLocalScreenTarget {
  kind: 'display' | 'window'
  id: string
}

export async function startJLocalScreenFeed(
  target: JLocalScreenTarget,
  opts: JLocalScreenFeedOptions,
): Promise<JLocalScreenFeed> {
  const { width, height, fps, audio = false } = opts
  const idKey = target.kind === 'window' ? 'window_id' : 'display_id'
  let started: Response
  try {
    started = await fetch(`${JLOCAL_ORIGIN}/capture/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [idKey]: target.id, width, height, fps }),
    })
  } catch {
    throw new Error('jlocal-capture-unavailable')
  }
  if (!started.ok) {
    // Surface the server's reason instead of a generic failure: the modal
    // shows it verbatim, except `permission`, which keeps the dedicated
    // Screen Recording hint.
    let detail = ''
    try {
      const body = (await started.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error.length > 0) detail = body.error
    } catch {
      // Non-JSON refusal: fall through to the generic failure below.
    }
    if (started.status === 503 && detail === 'permission') throw new Error('jlocal-capture-permission')
    throw new Error(detail.length > 0 ? `jlocal-capture-failed: ${detail}` : 'jlocal-capture-unavailable')
  }
  // New apps return an ownership token. Old apps omit it and keep the legacy
  // unconditional stop contract; with a token, a delayed cleanup from the
  // previous feed cannot kill a newly reconfigured session.
  let captureId: string | null = null
  try {
    const body = (await started.json()) as { capture_id?: unknown }
    if (typeof body.capture_id === 'string' && body.capture_id.length > 0) captureId = body.capture_id
    else if (typeof body.capture_id === 'number' && Number.isSafeInteger(body.capture_id)) captureId = String(body.capture_id)
  } catch {
    // Compatibility with early app builds and minimal test doubles.
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    stopCapture(captureId)
    throw new Error('jlocal-capture-unavailable')
  }
  // Bound once: the poll closure below must not re-narrow a captured binding.
  const g: CanvasRenderingContext2D = ctx

  let stopped = false
  const intervalMs = Math.max(1, Math.round(1000 / fps))
  let inFlight = false
  // Monotonic, not Date.now(): a frozen clock (background tab) must still
  // bust the cache on every poll.
  let pollTick = 0

  async function pollFrame(): Promise<void> {
    // No stacking: at 60fps a slow poll must skip, never overlap — overlaps
    // pile up out-of-order draws and judder.
    if (stopped || inFlight) return
    inFlight = true
    try {
      // fetch, not <img>: the loopback origin differs from the page, so an
      // <img> would taint the canvas and the captured stream would go black.
      // The endpoint answers CORS, hence these bytes decode clean.
      const response = await fetch(`${JLOCAL_ORIGIN}/capture/preview.jpg?t=${pollTick++}`)
      if (!response.ok || stopped) return
      const bitmap = await createImageBitmap(await response.blob())
      if (stopped) {
        bitmap.close()
        return
      }
      g.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
    } catch {
      // A missing or half-written JPEG skips this frame; the next tick tries again.
    } finally {
      inFlight = false
    }
  }

  function startPolling(): () => void {
    const timer = setInterval(() => {
      void pollFrame()
    }, intervalMs)
    return () => clearInterval(timer)
  }

  /**
   * One connection, server-paced MJPEG (`GET /capture/stream`): frames arrive
   * at the session rate with no HTTP-per-frame overhead and no overlap.
   * `onLive` fires on the first good response (the caller stops polling);
   * `onDead` fires when the stream ends or errors (the caller resumes
   * polling, so old apps and dropped connections keep a picture).
   */
  function startMjpeg(callbacks: {
    onLive: () => void
    onFrame: (bitmap: ImageBitmap) => void
    onDead: () => void
  }): () => void {
    const controller = new AbortController()
    const parser = new MjpegParser()
    let live = false
    let pendingFrame: Uint8Array | null = null
    let decoding = false

    const decodeLatest = async (): Promise<void> => {
      if (decoding) return
      decoding = true
      try {
        while (pendingFrame !== null && !stopped) {
          const frame = pendingFrame
          pendingFrame = null
          try {
            const bitmap = await createImageBitmap(new Blob([frame.buffer as ArrayBuffer], { type: 'image/jpeg' }))
            // Prefer freshness over replaying backlog: if another complete
            // frame arrived during decode, drop this stale bitmap.
            if (pendingFrame !== null || stopped) bitmap.close()
            else callbacks.onFrame(bitmap)
          } catch {
            // Corrupt/partial JPEG: the parser is length-framed, so the next
            // part remains aligned and can render normally.
          }
        }
      } finally {
        decoding = false
        if (pendingFrame !== null && !stopped) void decodeLatest()
      }
    }

    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      try {
        const response = await fetch(`${JLOCAL_ORIGIN}/capture/stream`, { signal: controller.signal })
        if (stopped) return
        if (!response.ok || !response.body) {
          if (!live) callbacks.onDead()
          return
        }
        live = true
        callbacks.onLive()
        reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (stopped) return
          if (done) {
            callbacks.onDead()
            return
          }
          const frames = parser.push(value)
          // Keep at most one not-yet-decoded frame. This bounds latency and
          // memory when JPEG decode is slower than capture (notably 4K/60).
          if (frames.length > 0) {
            pendingFrame = frames[frames.length - 1]
            void decodeLatest()
          }
        }
      } catch {
        // Refused before going live, or ended mid-stream: polling covers both.
        if (!stopped) callbacks.onDead()
      } finally {
        try {
          await reader?.cancel().catch(() => {})
        } catch {
          // Raced with stop(): nothing left to release.
        }
      }
    })()
    return () => controller.abort()
  }

  // Prefer the live stream; polling covers old apps and dropped connections.
  let stopFrames = startPolling()
  const stopStream = startMjpeg({
    onLive: () => {
      stopFrames()
    },
    onFrame: (bitmap) => {
      if (stopped) {
        bitmap.close()
        return
      }
      g.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
    },
    onDead: () => {
      if (stopped) return
      stopFrames()
      stopFrames = startPolling()
    },
  })
  const stopVideo = () => {
    stopFrames()
    stopStream()
  }

  const stream = canvas.captureStream(fps)

  // System audio rides the same stream when asked: the decoder appends its
  // destination track once the first PCM arrives, so publishScreen needs no
  // changes. The fetch never fails the feed — audio just stays absent.
  const stopAudio = audio ? startSystemAudio(stream, () => stopped) : null

  function stop(): void {
    if (stopped) return
    stopped = true
    stopVideo()
    // Cancel the PCM reader and close the context before stopping tracks,
    // so the decode loop exits instead of racing the teardown below.
    try {
      stopAudio?.()
    } catch {
      // Audio teardown must not block the video tracks or capture release.
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // One wedged track must not block the rest or the capture release.
      }
    }
    stopCapture(captureId)
  }

  return { stream, stop }
}
