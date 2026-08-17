import type { PlayState } from '../types'

export const DRIFT_THRESHOLD_MS = 450

export function expectedPositionMs(state: PlayState, nowServerMs: number): number {
  const elapsed = state.playing ? (nowServerMs - state.serverTimeMs) * state.rate : 0
  return Math.max(0, state.positionMs + elapsed)
}

export function needsResync(localMs: number, expectedMs: number): boolean {
  return Math.abs(localMs - expectedMs) > DRIFT_THRESHOLD_MS
}
