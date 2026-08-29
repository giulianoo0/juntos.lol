/**
 * How much buffer a start is held for.
 *
 * Two gates exist and they must agree. The server's counts a member ready
 * for a gated start once they hold this much contiguous media ahead of the
 * target (internal/sync/gate.go). The player's own gate holds a stopped
 * element until it has enough to play through its opening seconds without
 * stuttering back into the wait it just left.
 */

/** Mirrors the server's GateReadyBufferMs. */
export const GATE_READY_BUFFER_MS = 3000
/** The least the player's gate ever asks for, in seconds: the server's. */
export const GATE_FLOOR_SEC = GATE_READY_BUFFER_MS / 1000
/** What the player's gate asks for before a wait ends: enough that the
 * opening plays through an uplink hiccup without dropping straight back into
 * the wait it just left. */
export const GATE_BASE_SEC = 30

/**
 * The seconds the gate asks for in this exact situation.
 *
 * The base, strictly: a wait ends with the buffer built, not with whatever
 * the host had published when the viewer arrived — the host is producing
 * ahead the whole time, and leaving early on a thin edge means stalling
 * again seconds later. A sealed region and a gated start both take the
 * floor: the first only has downloading left to do, the second was already
 * held by the server for everyone at once, and holding it longer here would
 * start this viewer late.
 */
export function gateSecondsFor(input: {
  /** Element seconds where the growing region's published media ends; null
   * when the region is sealed or the room has no region map. */
  producedEdgeSec: number | null
  currentTime: number
  /** The region under the element has stopped growing. */
  sealed: boolean
  /** The server is holding a gated start the room will release together. */
  gatedStart: boolean
}): number {
  if (input.sealed || input.gatedStart) return GATE_FLOOR_SEC
  return GATE_BASE_SEC
}
