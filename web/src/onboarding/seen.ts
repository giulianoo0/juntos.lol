/**
 * Remembers that the onboarding was seen, keyed by version.
 *
 * By version, so that a later rewrite of what the app is can be shown again
 * without also showing it to somebody who has used it for a year and only
 * cleared a cookie.
 *
 * Its own file because Home reads it to decide whether to mount the component
 * at all, and a module that exports both a component and a plain function
 * breaks fast refresh.
 */
const SEEN_KEY = 'ss.onboarding.v1'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // Private mode, or storage refused. Showing it on every visit would be
    // worse than never showing it, so this counts as seen.
    return true
  }
}

export function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch { /* see above */ }
}
