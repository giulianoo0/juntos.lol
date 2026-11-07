/**
 * How much buffer a start is held for. Two gates must agree: the server's
 * (internal/sync/gate.go) and the player's, which holds a stopped element until
 * it can play through its opening seconds without stuttering back into a wait.
 */

/** Mirrors the server's GateReadyBufferMs. */
export const GATE_READY_BUFFER_MS = 3000
export const GATE_FLOOR_SEC = GATE_READY_BUFFER_MS / 1000
/** What a wait asks for when nothing argues it down. */
export const GATE_BASE_SEC = 10

/**
 * The seconds the gate asks for in this exact situation: a wait never asks for
 * more than the host has published, and a sealed region or a gated start both
 * take the floor.
 */
export function gateSecondsFor(input: {
  producedEdgeSec: number | null
  currentTime: number
  sealed: boolean
  gatedStart: boolean
}): number {
  if (input.sealed || input.gatedStart) return GATE_FLOOR_SEC
  if (input.producedEdgeSec === null) return GATE_BASE_SEC
  const available = input.producedEdgeSec - input.currentTime - 0.5
  return Math.min(GATE_BASE_SEC, Math.max(GATE_FLOOR_SEC, available))
}
