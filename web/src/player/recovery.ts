/**
 * How many times a media error may be recovered from before playback is called
 * off. The budget is windowed: two recoveries seconds apart is a player
 * thrashing; two an hour apart is a long film that hit two rough patches.
 */

export const MAX_RECOVERIES = 2
export const FORGIVE_MS = 30_000

export interface Recoveries {
  spent: number
  atMs: number
}

/**
 * The state after asking for one more recovery, or null when the budget is
 * spent and playback should be given up on.
 */
export function nextRecovery(current: Recoveries, nowMs: number): Recoveries | null {
  const spent = nowMs - current.atMs >= FORGIVE_MS ? 0 : current.spent
  if (spent >= MAX_RECOVERIES) return null
  return { spent: spent + 1, atMs: nowMs }
}
