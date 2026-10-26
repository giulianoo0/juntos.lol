/** RMS a voice has to reach to count as speech; well above a quiet room through noise suppression. */
const ON_LEVEL = 0.05
/** Once speaking, anything above this still counts, so a soft syllable does not flicker the ring. */
const OFF_LEVEL = 0.02
/** How long the level may stay low before speech is over: a breath between words is not a stop. */
const HANGOVER_MS = 400

/** Turns a stream of audio levels into "is this person talking", with hysteresis both ways. */
export class SpeakingDetector {
  private speaking = false
  private lastLoudAt = -Infinity

  update(level: number, now: number): boolean {
    if (level >= (this.speaking ? OFF_LEVEL : ON_LEVEL)) {
      this.speaking = true
      this.lastLoudAt = now
    } else if (this.speaking && now - this.lastLoudAt > HANGOVER_MS) {
      this.speaking = false
    }
    return this.speaking
  }
}

/** Root mean square of one analyser frame: 0 for silence, 1 for a full-scale square wave. */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}
