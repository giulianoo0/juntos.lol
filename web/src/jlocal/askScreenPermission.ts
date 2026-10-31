import { JLOCAL_ORIGIN } from './status'

/**
 * Brings the OS screen-recording prompt back up. Polled probes are report-only
 * (503 `permission`) so the picker's preview poll never reopens it; only a real
 * capture prompts, so this runs one tiny session from the click and stops it.
 * Resolves true when capture is allowed.
 */
export async function askJLocalScreenPermission(): Promise<boolean> {
  try {
    const id = await firstDisplayId()
    if (id === null) return false
    const started = await fetch(`${JLOCAL_ORIGIN}/capture/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_id: id, width: 640, height: 360, fps: 5 }),
    })
    const payload = (await started.json().catch(() => null)) as { capture_id?: unknown } | null
    const captureId = typeof payload?.capture_id === 'string' ? payload.capture_id : null
    void fetch(`${JLOCAL_ORIGIN}/capture/stop`, captureId === null ? { method: 'POST' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_id: captureId }),
    }).catch(() => undefined)
    return started.ok
  } catch {
    // The app went away mid-click; the status pill already says so.
    return false
  }
}

/** The first display the app lists, or null when it lists none. */
async function firstDisplayId(): Promise<string | null> {
  const listed = await fetch(`${JLOCAL_ORIGIN}/capture/displays`)
  if (!listed.ok) return null
  const body = (await listed.json()) as { displays?: unknown } | unknown[]
  const list = Array.isArray(body) ? body : (body as { displays?: unknown }).displays
  const first = Array.isArray(list) ? (list[0] as { id?: unknown } | undefined) : undefined
  return typeof first?.id === 'string' || typeof first?.id === 'number' ? String(first.id) : null
}

/**
 * Whether the app may capture the screen now: false is a definite no, null only
 * when the app is unreachable. Builds without the `permissions` block fall back
 * to one report-only snapshot, which answers 503 `permission` while denied.
 */
export async function probeJLocalScreenPermission(): Promise<boolean | null> {
  try {
    const advertised = await fetch(`${JLOCAL_ORIGIN}/capabilities`)
    if (advertised.ok) {
      const body = (await advertised.json()) as { capabilities?: { permissions?: { screenCapture?: unknown } } }
      const value = body.capabilities?.permissions?.screenCapture
      if (typeof value === 'boolean') return value
    }
    const id = await firstDisplayId()
    if (id === null) return null
    const snapshot = await fetch(`${JLOCAL_ORIGIN}/capture/snapshot?display_id=${encodeURIComponent(id)}&width=64`)
    if (snapshot.ok) return true
    if (snapshot.status !== 503) return null
    const body = (await snapshot.json().catch(() => null)) as { error?: unknown } | null
    return body?.error === 'permission' ? false : null
  } catch {
    return null
  }
}
