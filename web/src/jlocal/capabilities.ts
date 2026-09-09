import { JLOCAL_ORIGIN, getJLocalSnapshot, subscribeJLocal } from './status'

// Phase 1 of the companion-app contract: the web UI only reads what the app
// advertises. Every capability stays false until the app implements it, and a
// missing or malformed payload parses to null rather than throwing, so the
// native browser flows keep working untouched.
export interface JLocalCapabilities {
  screen: { available: boolean; capture: boolean; h264: boolean; maxWidth: number; maxHeight: number; maxFps: number }
  audio: { appList: boolean; capture: boolean }
  torrent: { available: boolean }
}

const FETCH_TIMEOUT_MS = 1500
const CACHE_TTL_MS = 60000

let cache: { data: JLocalCapabilities | null; at: number } = { data: null, at: 0 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCapabilities(body: unknown): JLocalCapabilities | null {
  if (!isRecord(body)) return null
  if (body.name !== 'jlocal' || typeof body.version !== 'string') return null
  const caps = body.capabilities
  if (!isRecord(caps)) return null
  const { screen, audio, torrent } = caps
  if (!isRecord(screen) || !isRecord(audio) || !isRecord(torrent)) return null
  if (typeof screen.available !== 'boolean') return null
  if (typeof screen.capture !== 'boolean') return null
  if (typeof screen.maxWidth !== 'number' || !Number.isFinite(screen.maxWidth)) return null
  if (typeof screen.maxHeight !== 'number' || !Number.isFinite(screen.maxHeight)) return null
  if (typeof screen.maxFps !== 'number' || !Number.isFinite(screen.maxFps)) return null
  if (typeof audio.appList !== 'boolean') return null
  // capture is new: old apps omit it and still parse, defaulting to silent.
  if (audio.capture !== undefined && typeof audio.capture !== 'boolean') return null
  if (typeof torrent.available !== 'boolean') return null
  return {
    screen: {
      available: screen.available,
      capture: screen.capture,
      // Hardware H.264 over loopback; older apps omit it and fall back to JPEG frames.
      h264: screen.h264 === true,
      maxWidth: screen.maxWidth,
      maxHeight: screen.maxHeight,
      maxFps: screen.maxFps,
    },
    audio: { appList: audio.appList, capture: audio.capture === true },
    torrent: { available: torrent.available },
  }
}

/** GET the app's capability advertisement. Never throws: anything off-shape is null. */
export async function fetchJLocalCapabilities(signal: AbortSignal): Promise<JLocalCapabilities | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/capabilities`, { signal })
    if (!response.ok) return null
    return parseCapabilities(await response.json())
  } catch {
    return null
  }
}

/** Sync read of the last advertisement; null when never fetched. */
export function getCachedJLocalCapabilities(): JLocalCapabilities | null {
  return cache.data
}

/** One-shot background refresh. Only fires while the app is connected; no timer of its own. */
export function refreshJLocalCapabilities(): void {
  if (!getJLocalSnapshot().connected) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
  void fetchJLocalCapabilities(controller.signal).then((caps) => {
    cache = { data: caps, at: Date.now() }
  }).finally(() => clearTimeout(timer))
}

/**
 * Sync gate for the three screen entries. Pure read, no fetch, no await: it
 * must run before any await so Firefox user-activation survives on the native
 * fallback path. When connected but uncached/stale it kicks off a background
 * refresh and still answers false for this click.
 */
export function isJLocalCaptureAvailable(): boolean {
  const snapshot = getJLocalSnapshot()
  const fresh = cache.data !== null && Date.now() - cache.at <= CACHE_TTL_MS ? cache.data : null
  // Capture is advertised separately from relay publish: the app can capture
  // (capture true) long before it can publish (available stays false).
  const available = snapshot.connected && fresh?.screen.capture === true
  if (!available && snapshot.connected && fresh === null) refreshJLocalCapabilities()
  return available
}

// Warm the cache the moment the app connects, so the first share click per
// page load already sees screen.capture instead of falling through to the
// native picker while a background refresh is still in flight. One-way
// dependency (capabilities -> status); the subscription lives for the session.
let lastConnected = false
subscribeJLocal(() => {
  const connected = getJLocalSnapshot().connected
  if (connected && !lastConnected) refreshJLocalCapabilities()
  lastConnected = connected
})

/** Test-only reset for the module cache. */
export function resetJLocalCapabilitiesForTests(): void {
  cache = { data: null, at: 0 }
}
