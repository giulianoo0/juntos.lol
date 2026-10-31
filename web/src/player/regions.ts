import type { MediaRegion } from '../types'

const REGION_AHEAD_MS = 30_000
// The server's followBehindMs (internal/worker/remux.go) must not exceed
// this: a position it calls covered that no region here holds is a room that
// waits forever.
export const REGION_BEHIND_MS = 1_000

/** Whether a region holds a position: a growing one, up to 30 s ahead of what it wrote. */
export function regionHolds(region: MediaRegion, ms: number): boolean {
  const end = region.startMs + region.producedMs + (region.growing ? REGION_AHEAD_MS : 0)
  return ms >= region.startMs - REGION_BEHIND_MS && ms <= end
}
