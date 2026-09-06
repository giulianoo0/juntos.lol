import { getCachedJLocalCapabilities } from './capabilities'
import { JLOCAL_ORIGIN } from './status'

// Companion-app system-audio controls. Every helper is fire-and-forget safe:
// anything off-shape or unreachable resolves, never rejects, so UI toggles
// stay responsive while the app is gone and the room gear owns its own retry.

export type JLocalAudioMode = 'all' | 'none' | 'custom'

/** POST /audio/mode. Never throws: a failed persist just resolves. */
export async function setJLocalAudioMode(mode: JLocalAudioMode): Promise<void> {
  try {
    await fetch(`${JLOCAL_ORIGIN}/audio/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
  } catch {
    // Best-effort persist; the server keeps its last live mode.
  }
}

/** POST /audio/mute {app, muted}. Never throws. */
export async function setJLocalAppMuted(app: string, muted: boolean): Promise<void> {
  try {
    await fetch(`${JLOCAL_ORIGIN}/audio/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app, muted }),
    })
  } catch {
    // Best-effort persist; the server keeps its last mute set.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface JLocalWindowApp {
  id: string
  app: string
  name: string
}

/**
 * GET /capture/windows as a tolerant app list. Never throws: anything
 * off-shape or unreachable resolves to [] and the caller shows its own
 * empty state. App names match the `app` field the mute endpoint wants.
 */
export async function fetchJLocalWindows(signal?: AbortSignal): Promise<JLocalWindowApp[]> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/capture/windows`, { signal })
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.windows)) return []
    const found: JLocalWindowApp[] = []
    for (const entry of body.windows) {
      if (!isRecord(entry)) continue
      const { id, app, name } = entry
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof app !== 'string' || typeof name !== 'string') continue
      found.push({ id: String(id), app, name })
    }
    return found
  } catch {
    return []
  }
}

/** Sync gate for any audio UI. Pure read of the cached advertisement. */
export function isJLocalAudioCaptureAvailable(): boolean {
  return getCachedJLocalCapabilities()?.audio.capture === true
}
