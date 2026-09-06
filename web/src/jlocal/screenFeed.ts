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

// PCM contract: the server flushes ~20ms frames of s16le 48kHz stereo with
// no framing headers — a raw infinite body, so any chunk boundary can split
// a frame and the decoder below reassembles by byte count.
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const AUDIO_FRAME_SAMPLES = 960
const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2

export interface JLocalScreenFeed {
  stream: MediaStream
  stop: () => void
}

/** Best-effort capture release. Never throws: stop() must not fail. */
function stopCapture(): void {
  try {
    Promise.resolve(fetch(`${JLOCAL_ORIGIN}/capture/stop`, { method: 'POST' })).catch(() => {})
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

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    stopCapture()
    throw new Error('jlocal-capture-unavailable')
  }
  // Bound once: the poll closure below must not re-narrow a captured binding.
  const g: CanvasRenderingContext2D = ctx

  let stopped = false
  const intervalMs = Math.max(1, Math.round(1000 / fps))

  async function pollFrame(): Promise<void> {
    if (stopped) return
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('frame'))
        img.src = `${JLOCAL_ORIGIN}/capture/preview.jpg?t=${Date.now()}`
      })
      if (stopped) return
      const bitmap = await createImageBitmap(img)
      if (stopped) {
        bitmap.close()
        return
      }
      g.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
    } catch {
      // A missing or half-written JPEG skips this frame; the next tick tries again.
    }
  }

  const timer = setInterval(() => {
    void pollFrame()
  }, intervalMs)

  const stream = canvas.captureStream(fps)

  // System audio rides the same stream when asked: the decoder appends its
  // destination track once the first PCM arrives, so publishScreen needs no
  // changes. The fetch never fails the feed — audio just stays absent.
  const stopAudio = audio ? startSystemAudio(stream, () => stopped) : null

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
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
    stopCapture()
  }

  return { stream, stop }
}
