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
/** What the player's gate asks for when nothing argues it down. Four-second
 * segments: less than a few of them plays straight back into the wait. */
export const GATE_BASE_SEC = 10

/**
 * The seconds the gate asks for in this exact situation.
 *
 * Never more than the host has published: a region still growing has a
 * produced edge, and waiting for ten seconds past it is waiting for media
 * that does not exist yet — the viewer sits while the host's uplink fills
 * seconds that would have played fine one at a time. A sealed region and a
 * gated start both take the floor: the first only has downloading left to
 * do, the second was already held by the server for everyone at once.
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
  if (input.producedEdgeSec === null) return GATE_BASE_SEC
  const available = input.producedEdgeSec - input.currentTime - 0.5
  return Math.min(GATE_BASE_SEC, Math.max(GATE_FLOOR_SEC, available))
}
