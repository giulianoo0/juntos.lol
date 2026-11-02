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

/**
 * Whether a region already wrote a position and `aheadMs` past it: what
 * starting the room's clock there needs. Holding it is not enough: a region
 * opened a moment ago holds what it will write, and a clock started on that
 * runs off while a slow torrent cold-starts, until the region is dropped for
 * one further on and the room never plays.
 */
export function regionHas(region: MediaRegion, ms: number, aheadMs: number): boolean {
  if (ms < region.startMs - REGION_BEHIND_MS) return false
  const written = region.startMs + region.producedMs
  return region.growing ? written >= ms + aheadMs : ms <= written
}
