/**
 * Local playback for the host: the browser that remuxed the source plays it
 * straight from the fMP4 fragments it produced, fed into a MediaSource, with
 * no round-trip through the bucket and no cross-origin fetch. The same CMAF
 * bytes still go to R2 for the viewers; this just spares the host from being
 * one of them.
 *
 * Single-variant only — one SourceBuffer, so one init segment and a single
 * stream of media segments (video with at most one muxed audio track). A
 * multi-dub source splits into separate audio playlists and falls back to the
 * bucket/hls.js path, where alternate-audio already works.
 */

export interface LocalPlayback {
  /** The object URL to hand a <video> element as its src. */
  url: string
  /** The init segment; must be pushed before any media segment. */
  pushInit: (bytes: Uint8Array, codecs: string) => void
  /** A media fragment, in playback order. */
  pushSegment: (bytes: Uint8Array) => void
  /** No more segments are coming: the stream ends after what is buffered. */
  end: () => void
  /** Tears down the MediaSource and revokes the URL. */
  dispose: () => void
}

const registry = new Map<string, LocalPlayback>()
const listeners = new Map<string, Set<(playback: LocalPlayback) => void>>()

/** The host's local playback for a room, if one is being produced here. */
export function getLocalPlayback(roomID: string): LocalPlayback | undefined {
  return registry.get(roomID)
}

/** Fires once the room's local playback exists, immediately if already present. */
export function subscribeLocalPlayback(roomID: string, listener: (playback: LocalPlayback) => void): () => void {
  const existing = registry.get(roomID)
  if (existing) listener(existing)
  const set = listeners.get(roomID) ?? new Set()
  set.add(listener)
  listeners.set(roomID, set)
  return () => set.delete(listener)
}

/**
 * Stands up a MediaSource fed by pushed fragments. Returns null when the
 * browser cannot back playback this way (no MediaSource), so the caller keeps
 * to the bucket path.
 */
export function createLocalPlayback(roomID: string): LocalPlayback | null {
  if (typeof MediaSource === 'undefined') return null

  const mediaSource = new MediaSource()
  const url = URL.createObjectURL(mediaSource)
  // Fragments arrive before the SourceBuffer exists (the init segment creates
  // it), and appends cannot overlap, so everything is queued and drained one
  // at a time as `updateend` fires.
  const queue: Uint8Array[] = []
  let sourceBuffer: SourceBuffer | null = null
  let ended = false
  let disposed = false
  let pendingEnd = false

  const pump = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating) return
    const next = queue.shift()
    if (next) {
      try {
        sourceBuffer.appendBuffer(next as BufferSource)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'QuotaExceededError') {
          // The buffer is full: drop what is well behind the playhead and
          // retry. A long film cannot sit entirely in memory.
          queue.unshift(next)
          evictBehind()
        } else {
          fail()
        }
      }
      return
    }
    if (pendingEnd && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch { /* already ended or torn down */ }
    }
  }

  const evictBehind = () => {
    if (!sourceBuffer || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return
    const start = sourceBuffer.buffered.start(0)
    const keepFrom = Math.max(start, currentPlayhead() - 30)
    if (keepFrom > start + 1) {
      try {
        sourceBuffer.remove(start, keepFrom)
      } catch { /* a remove already runs */ }
    }
  }

  // The playhead is read off the one media element bound to this URL, so a
  // full buffer is trimmed behind wherever the viewer actually is.
  const currentPlayhead = (): number => {
    for (const video of document.querySelectorAll('video')) {
      if (video.currentSrc === url) return video.currentTime
    }
    return 0
  }

  const fail = () => {
    // A failed local playback is not fatal: dispose so the room falls back to
    // the bucket path, which is always there.
    dispose()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    registry.delete(roomID)
    try {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    } catch { /* nothing to end */ }
    URL.revokeObjectURL(url)
  }

  const playback: LocalPlayback = {
    url,
    pushInit: (bytes, codecs) => {
      if (disposed || sourceBuffer) return
      const mime = `video/mp4; codecs="${codecs}"`
      if (!MediaSource.isTypeSupported(mime)) { fail(); return }
      const attach = () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mime)
          sourceBuffer.addEventListener('updateend', pump)
          queue.unshift(bytes)
          pump()
        } catch { fail() }
      }
      if (mediaSource.readyState === 'open') attach()
      else mediaSource.addEventListener('sourceopen', attach, { once: true })
    },
    pushSegment: (bytes) => {
      if (disposed || ended) return
      queue.push(bytes)
      pump()
    },
    end: () => {
      if (disposed) return
      ended = true
      pendingEnd = true
      pump()
    },
    dispose,
  }

  registry.set(roomID, playback)
  for (const listener of listeners.get(roomID) ?? []) listener(playback)
  return playback
}

/** Pulls the codec list out of a master playlist's first STREAM-INF. */
export function codecsFromMaster(master: string): string | null {
  const match = master.match(/CODECS="([^"]+)"/)
  return match ? match[1] : null
}
