/**
 * The clicks the onboarding makes, synthesised rather than shipped.
 *
 * Three reasons this is code and not a folder of .mp3s: nothing is downloaded,
 * nothing needs a licence, and a short oscillator envelope is easier to keep
 * in the same register as the rest of the interface than a sample somebody
 * recorded for a different app.
 *
 * Only ever called from a click handler. A browser refuses to start audio
 * before a gesture, so anything that tried to play on its own would be
 * silently blocked — and unannounced sound on a page nobody asked it of is
 * worse than no sound at all.
 */

type Ctor = typeof AudioContext

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (context) return context
  const Available: Ctor | undefined = globalThis.AudioContext
    ?? (globalThis as { webkitAudioContext?: Ctor }).webkitAudioContext
  if (!Available) return null
  try {
    context = new Available()
    return context
  } catch {
    // Autoplay policy, or a browser with audio switched off entirely. Silence
    // is a fine outcome; a thrown error in a click handler is not.
    return null
  }
}

interface Blip {
  /** Hertz at the start of the note. */
  from: number
  /** Hertz at the end — a small fall reads as a click, a rise as a lift. */
  to: number
  /** Seconds. Anything past about 0.12 stops being a click and becomes a beep. */
  duration: number
  /** Peak gain. Deliberately low: this sits under the interface, not on it. */
  gain: number
  type: OscillatorType
}

function play({ from, to, duration, gain, type }: Blip): void {
  const ctx = audio()
  if (!ctx) return
  // Suspended is what a context becomes when the tab was backgrounded; a
  // click is a gesture, so resuming here is allowed.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)

  const now = ctx.currentTime
  const oscillator = ctx.createOscillator()
  const envelope = ctx.createGain()

  oscillator.type = type
  oscillator.frequency.setValueAtTime(from, now)
  oscillator.frequency.exponentialRampToValueAtTime(to, now + duration)

  // A hard start clicks in the speaker rather than in the design, so the
  // attack is a couple of milliseconds instead of zero.
  envelope.gain.setValueAtTime(0.0001, now)
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.008)
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)

  oscillator.connect(envelope).connect(ctx.destination)
  oscillator.start(now)
  oscillator.stop(now + duration + 0.02)
}

/** Moving forward: a short rise. */
export function playAdvance(): void {
  play({ from: 520, to: 780, duration: 0.09, gain: 0.05, type: 'sine' })
}

/** Going back: the same shape, falling. */
export function playBack(): void {
  play({ from: 620, to: 380, duration: 0.09, gain: 0.04, type: 'sine' })
}

/**
 * Something failed. Two falling notes, low and short.
 *
 * Lives here rather than in its own module because it is the same synthesiser
 * and the same register: an app with two unrelated sound vocabularies sounds
 * like two apps.
 */
export function playError(): void {
  play({ from: 400, to: 300, duration: 0.1, gain: 0.05, type: 'sine' })
  const ctx = audio()
  if (!ctx) return
  window.setTimeout(() => play({ from: 300, to: 200, duration: 0.18, gain: 0.045, type: 'sine' }), 95)
}

/** The last step. Two notes, a third apart, so the end sounds like an end. */
export function playFinish(): void {
  play({ from: 620, to: 660, duration: 0.11, gain: 0.05, type: 'sine' })
  const ctx = audio()
  if (!ctx) return
  window.setTimeout(() => play({ from: 830, to: 880, duration: 0.16, gain: 0.045, type: 'sine' }), 90)
}
