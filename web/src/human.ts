import { useEffect, useSyncExternalStore } from 'react'
import { loadPublicConfig } from './publicConfig'

// Turnstile in front of opening and entering rooms. The server names the
// widget; the token is spent once on /api/human, which leaves a day-long
// cookie, and until it runs out nobody is asked again.
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const STORAGE_KEY = 'ss.human'
/** Re-check a little before the cookie runs out, not on the minute it does. */
const MARGIN_MS = 10 * 60_000
const TIMEOUT_MS = 30_000

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string
  execute(widget: string): void
  remove(widget: string): void
}

declare global {
  interface Window { turnstile?: Turnstile }
}

const enabled = import.meta.env.MODE !== 'test'

/** The bot check did not pass; `reason` is also what the server logs. */
export class HumanError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super('human_failed')
    this.reason = reason
  }
}

/** Tells the server about a check that died in the browser, where it would never see it. */
function report(reason: string) {
  try {
    navigator.sendBeacon?.('/api/human/failure', new Blob([JSON.stringify({ reason })], { type: 'application/json' }))
  } catch {}
}

let checking = false
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null
let script: Promise<Turnstile> | null = null
function setChecking(next: boolean) {
  checking = next
  for (const listener of listeners) listener()
}

/** Whether the bot check is running right now, for the bubble over the button. */
export function useHumanCheck(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => checking)
}

function fresh(): boolean {
  try {
    return Number(localStorage.getItem(STORAGE_KEY) ?? 0) > Date.now() + MARGIN_MS
  } catch {
    return false
  }
}

function loadScript(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const tag = document.createElement('script')
    tag.src = SCRIPT_URL
    tag.async = true
    tag.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new HumanError('script'))
    tag.onerror = () => {
      script = null
      tag.remove()
      reject(new HumanError('script'))
    }
    document.head.append(tag)
  })
  return script
}

async function solve(sitekey: string): Promise<string> {
  const turnstile = await loadScript()
  const container = document.createElement('div')
  document.body.append(container)
  let widget = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new HumanError('timeout')), TIMEOUT_MS)
      widget = turnstile.render(container, {
        sitekey,
        action: 'human',
        execution: 'execute',
        callback: (token: string) => { window.clearTimeout(timer); resolve(token) },
        'error-callback': (code?: string) => { window.clearTimeout(timer); reject(new HumanError(`widget-${code ?? 'unknown'}`)) },
        'timeout-callback': () => { window.clearTimeout(timer); reject(new HumanError('timeout')) },
      })
      turnstile.execute(widget)
    })
  } finally {
    if (widget) turnstile.remove(widget)
    container.remove()
  }
}

async function verify(): Promise<void> {
  const sitekey = (await loadPublicConfig()).turnstileSiteKey
  if (!sitekey) return
  setChecking(true)
  try {
    let token: string
    try {
      token = await solve(sitekey)
    } catch (error) {
      const failure = error instanceof HumanError ? error : new HumanError('widget')
      report(failure.reason)
      throw failure
    }
    const response = await fetch('/api/human', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    // The server logged why it said no.
    if (!response.ok) throw new HumanError('server')
    const { expiresAt } = await response.json() as { expiresAt: string }
    try { localStorage.setItem(STORAGE_KEY, String(Date.parse(expiresAt))) } catch {}
  } finally {
    setChecking(false)
  }
}

/** Whether this browser may open and enter rooms right now, without asking. */
export function humanReady(): boolean {
  return !enabled || fresh()
}

/** Resolves once this browser may open and enter rooms; instant while the last check holds. */
export function ensureHuman(): Promise<void> {
  if (humanReady()) return Promise.resolve()
  inflight ??= verify().finally(() => { inflight = null })
  return inflight
}

/** The server said the check ran out: forget it, so the next ensureHuman asks again. */
export function forgetHuman() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

/** Starts the check as soon as a page that leads into a room is on screen,
    so the click that opens or enters one rarely waits for it. A failure here
    is reported and left for that click to retry. */
export function useHumanPrecheck() {
  useEffect(() => {
    void ensureHuman().catch(() => undefined)
  }, [])
}
