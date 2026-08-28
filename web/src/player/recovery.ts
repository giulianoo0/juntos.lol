/**
 * How many times a media error may be recovered from before playback is
 * called off.
 *
 * A budget without a clock is the wrong shape. Two recoveries in a row and
 * seconds apart is a player thrashing, and stopping is the honest answer. Two
 * recoveries an hour apart is a long film that hit a rough patch twice, and
 * refusing the second one strands the room on a still frame for the rest of
 * the episode.
 *
 * This mattered the moment the player stopped rebuilding itself on every
 * publish: the rebuild used to reset the count every couple of seconds, so
 * nobody had ever spent the budget. With the rebuild gone the count was for
 * life, and the second rough patch of an evening was fatal.
 */

/** Recoveries allowed inside one window before playback is given up on. */
export const MAX_RECOVERIES = 2
/** Healthy playback for this long forgives everything before it. */
export const FORGIVE_MS = 30_000

export interface Recoveries {
  /** Recoveries spent in the current window. */
  spent: number
  /** When the last one was attempted. */
  atMs: number
}

/**
 * The state after asking for one more recovery, or null when the budget is
 * spent and playback should be given up on.
 */
export function nextRecovery(current: Recoveries, nowMs: number): Recoveries | null {
  // A stretch of healthy playback since the last attempt means whatever went
  // wrong then is not what is going wrong now: the window starts over.
  const spent = nowMs - current.atMs >= FORGIVE_MS ? 0 : current.spent
  if (spent >= MAX_RECOVERIES) return null
  return { spent: spent + 1, atMs: nowMs }
}
