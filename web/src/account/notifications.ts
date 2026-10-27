import { useEffect, useSyncExternalStore } from 'react'
import { fetchNotifications, type Notifications } from '../account'

/** How often the badge asks again while the tab is in view. */
export const POLL_MS = 60_000
/** Coming back to the tab asks again only when the last answer is older than this. */
const STALE_MS = 15_000

// One copy for every badge on the page, one request per poll.
let current: Notifications | null = null
let fetchedAt = 0
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function publish(next: Notifications | null) {
  current = next
  for (const listener of listeners) listener()
}

/** Asks the server again now; a call already on its way is reused. */
export function refreshNotifications(): Promise<void> {
  inflight ??= fetchNotifications()
    .then((next) => { fetchedAt = Date.now(); publish(next) })
    .catch(() => undefined)
    .finally(() => { inflight = null })
  return inflight
}

/** Takes something off the list at once, before the server confirms. */
export function forgetNotification(change: (notifications: Notifications) => Notifications) {
  if (current) publish(change(current))
}

function hidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function schedule() {
  clearTimeout(timer)
  if (listeners.size === 0 || hidden()) return
  timer = setTimeout(() => { void refreshNotifications().then(schedule) }, POLL_MS)
}

function onVisibility() {
  if (hidden()) {
    clearTimeout(timer)
    return
  }
  if (Date.now() - fetchedAt > STALE_MS) void refreshNotifications().then(schedule)
  else schedule()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    if (!hidden() && Date.now() - fetchedAt > STALE_MS) void refreshNotifications().then(schedule)
    else schedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

const noSubscribe = () => () => undefined

/**
 * What waits on the signed-in account, polled once a minute while the tab
 * is in view; null before the first answer or when `signedIn` is off.
 */
export function useNotifications(signedIn: boolean): Notifications | null {
  const state = useSyncExternalStore(signedIn ? subscribe : noSubscribe, () => current)
  useEffect(() => {
    if (!signedIn && current) publish(null)
  }, [signedIn])
  return signedIn ? state : null
}

/** Test seam: forget everything between tests. */
export function resetNotifications() {
  clearTimeout(timer)
  current = null
  fetchedAt = 0
  inflight = null
}
