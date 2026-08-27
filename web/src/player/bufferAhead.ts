import type { BufferedRange } from './Player'

/**
 * How much media is ready from the playhead onward, without a gap.
 *
 * Not the sum of the buffered ranges: a hole between two of them is exactly
 * where playback would stop, so only what is reachable without crossing one
 * counts as ready. Ranges come out of the element in order, so a single pass
 * extends the run until it breaks.
 */
export function bufferAhead(ranges: readonly BufferedRange[], currentTime: number): number {
  let reach = currentTime
  for (const range of ranges) {
    if (range.end <= reach) continue
    // A hairline gap is the element's own rounding, not a hole in the media.
    if (range.start > reach + 0.5) break
    reach = range.end
  }
  return Math.max(reach - currentTime, 0)
}

/**
 * Whether play should wait for more of it.
 *
 * Only while stopped: once playing, a thin buffer belongs to the stall logic,
 * and pausing into this would be the room stopping itself. Never at the end of
 * the timeline, where the seconds being waited for do not exist and never will.
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
