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

export interface JLocalAudioApp {
  id: string
  name: string
}

/**
 * GET /audio/apps: the apps whose sound the mix can leave out, by the ids
 * the mute endpoint takes. Never throws: a 501 or an unreachable app is [].
 */
export async function fetchJLocalAudioApps(signal?: AbortSignal): Promise<JLocalAudioApp[]> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/audio/apps`, { signal })
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.apps)) return []
    const found: JLocalAudioApp[] = []
    for (const entry of body.apps) {
      if (!isRecord(entry)) continue
      const { id, name } = entry
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue
      found.push({ id: String(id), name })
    }
    return found.sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/**
 * The apps worth a row in a sounds menu: those with a window open, named
 * as `/audio/apps` names them and keyed by the id the mute endpoint takes.
 * The audio list on its own is every GUI process on the machine, agents and
 * helpers included; the window list is what a person recognises as an app.
 * Should the two lists fail to line up at all, the audio list stands.
 */
export async function fetchJLocalSoundApps(signal?: AbortSignal): Promise<JLocalAudioApp[]> {
  const [apps, windows] = await Promise.all([fetchJLocalAudioApps(signal), fetchJLocalWindows(signal)])
  const open = new Set(windows.map((window) => window.app.trim().toLowerCase()))
  const listed = apps.filter((app) => open.has(app.id) || open.has(app.name.trim().toLowerCase()))
  return listed.length > 0 ? listed : apps
}
