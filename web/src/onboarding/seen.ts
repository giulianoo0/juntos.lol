/**
 * Remembers that the onboarding was seen, keyed by version so a later rewrite
 * can be shown again. Its own file: Home reads it, and a module exporting both
 * a component and a plain function breaks fast refresh.
 */
const SEEN_KEY = 'ss.onboarding.v1'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

export function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {}
}
