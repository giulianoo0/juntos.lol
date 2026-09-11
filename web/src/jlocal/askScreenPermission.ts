import { JLOCAL_ORIGIN } from './status'

/**
 * Brings the OS screen-recording prompt back up.
 *
 * Nothing the site polls ever prompts: the app answers 503 `permission` from
 * a report-only probe, precisely so the picker's 1s preview poll cannot
 * re-open the system dialog. So the prompt has to come from a click, and the
 * only thing that raises it is a real capture — one tiny session on the first
 * display, stopped as soon as it starts. Resolves true when capture is
 * allowed (the grant is live, or was already there).
 */
export async function askJLocalScreenPermission(): Promise<boolean> {
  try {
    const listed = await fetch(`${JLOCAL_ORIGIN}/capture/displays`)
    if (!listed.ok) return false
    const body = (await listed.json()) as { displays?: unknown } | unknown[]
    const list = Array.isArray(body) ? body : (body as { displays?: unknown }).displays
    const first = Array.isArray(list) ? (list[0] as { id?: unknown } | undefined) : undefined
    const id = typeof first?.id === 'string' || typeof first?.id === 'number' ? String(first.id) : null
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
