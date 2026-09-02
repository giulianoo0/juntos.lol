import type { BufferedRange } from './Player'

/**
 * How much media is ready from the playhead onward, without a gap: not the sum
 * of the buffered ranges, since a hole between two of them is exactly where
 * playback would stop.
 */
export function bufferAhead(ranges: readonly BufferedRange[], currentTime: number): number {
  let reach = currentTime
  for (const range of ranges) {
    if (range.end <= reach) continue
    if (range.start > reach + 0.5) break
    reach = range.end
  }
  return Math.max(reach - currentTime, 0)
}

/**
 * Whether play should wait for more of it. Only while stopped — a thin buffer
 * mid-playback belongs to the stall logic — and never at the end of the
 * timeline, where the seconds waited for do not exist.
 */
export function holdsForBuffer(input: {
  aheadSec: number
  gateSec: number
  currentTime: number
  timelineEnd: number
  playing: boolean
  ready: boolean
}): boolean {
  if (input.playing || !input.ready) return false
  if (input.timelineEnd > 0 && input.currentTime + input.gateSec >= input.timelineEnd - 0.5) return false
  return input.aheadSec < input.gateSec
}
