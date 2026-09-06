import { JLOCAL_ORIGIN } from './status'

// Screen frames captured by the companion app, published through the existing
// browser MoQ pipeline. The app only captures: this module polls its latest
// JPEG onto a canvas and hands out canvas.captureStream(), which the feed
// module passes to stashScreenStream(roomID, stream) like any browser-picked
// surface. Video-only v1: system audio stays with the browser path.
export interface JLocalScreenFeedOptions {
  width: number
  height: number
  fps: number
}

export interface JLocalScreenFeed {
  stream: MediaStream
  stop: () => void
}

/** Best-effort capture release. Never throws: stop() must not fail. */
function stopCapture(): void {
  try {
    Promise.resolve(fetch(`${JLOCAL_ORIGIN}/capture/stop`, { method: 'POST' })).catch(() => {})
  } catch {
    // The timer is already cleared and the tracks already stopped; a dead
    // companion app leaves nothing else to clean up.
  }
}

/**
 * Starts app-side capture for a display or a window and returns a live
 * MediaStream of its frames. Throws Error('jlocal-capture-unavailable') when
 * the app refuses or the canvas cannot be set up. Frame poll failures skip
 * that frame and keep polling; only stop() ends the loop.
 */
export interface JLocalScreenTarget {
  kind: 'display' | 'window'
  id: string
}

export async function startJLocalScreenFeed(
  target: JLocalScreenTarget,
  opts: JLocalScreenFeedOptions,
): Promise<JLocalScreenFeed> {
  const { width, height, fps } = opts
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
  if (!started.ok) throw new Error('jlocal-capture-unavailable')

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

  // Canvas streams carry video only, which is exactly the v1 contract.
  const stream = canvas.captureStream(fps)

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
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
