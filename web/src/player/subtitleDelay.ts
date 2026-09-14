/**
 * A per-viewer shift of the subtitles against the video: positive shows them
 * later, negative sooner. Cues are moved in place on the parsed track, so the
 * browser keeps deciding which are active; ASS goes through the renderer's
 * own offset instead.
 */
export const DELAY_STEP_MS = 250
export const DELAY_LIMIT_MS = 600_000

export function formatDelay(ms: number, language: string): string {
  const seconds = (Math.abs(ms) / 1000).toFixed(2).replace('.', language === 'pt-BR' ? ',' : '.')
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : ''
  return `${sign}${seconds} s`
}

/** Seconds as typed, with either decimal mark; null when it is not a number. */
export function parseDelay(text: string): number | null {
  const cleaned = text.replace(/\s|s$/gi, '').replace(',', '.')
  if (cleaned === '' || !/^[+-]?\d*\.?\d+$/.test(cleaned)) return null
  const ms = Math.round(Number(cleaned) * 1000)
  if (!Number.isFinite(ms)) return null
  return Math.max(-DELAY_LIMIT_MS, Math.min(DELAY_LIMIT_MS, ms))
}

interface RetimableTrack {
  cues: ArrayLike<{ startTime: number; endTime: number }> | null
}

export function retimeCues(track: RetimableTrack, deltaSec: number): void {
  if (deltaSec === 0 || !track.cues) return
  const cues = Array.from(track.cues)
  for (const cue of cues) {
    cue.startTime += deltaSec
    cue.endTime += deltaSec
  }
}
