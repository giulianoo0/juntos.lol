/**
 * The cues showing at a time, read from the track itself: the browser's own
 * activeCues only refresh as time marches on, so a cue moved while the video
 * is paused would keep showing where it no longer belongs.
 */
export function activeCuesAt<T extends { startTime: number; endTime: number }>(cues: ArrayLike<T> | null | undefined, time: number): T[] {
  if (!cues) return []
  const out: T[] = []
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    if (cue.startTime <= time && time < cue.endTime) out.push(cue)
  }
  return out
}
