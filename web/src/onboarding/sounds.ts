/**
 * The clicks the onboarding makes, synthesised rather than shipped. Only ever
 * called from a click handler: a browser refuses to start audio before a
 * gesture, and unannounced sound is worse than none.
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
    // Silence is a fine outcome; a throw in a click handler is not.
    return null
  }
}

interface Blip {
  from: number
  to: number
  duration: number
  gain: number
  type: OscillatorType
}

function play({ from, to, duration, gain, type }: Blip): void {
  const ctx = audio()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)

  const now = ctx.currentTime
  const oscillator = ctx.createOscillator()
  const envelope = ctx.createGain()

  oscillator.type = type
  oscillator.frequency.setValueAtTime(from, now)
  oscillator.frequency.exponentialRampToValueAtTime(to, now + duration)

  // A zero attack clicks in the speaker rather than in the design.
  envelope.gain.setValueAtTime(0.0001, now)
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.008)
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)

  oscillator.connect(envelope).connect(ctx.destination)
  oscillator.start(now)
  oscillator.stop(now + duration + 0.02)
}

export function playAdvance(): void {
  play({ from: 520, to: 780, duration: 0.09, gain: 0.05, type: 'sine' })
}

export function playBack(): void {
  play({ from: 620, to: 380, duration: 0.09, gain: 0.04, type: 'sine' })
}

export function playError(): void {
  play({ from: 400, to: 300, duration: 0.1, gain: 0.05, type: 'sine' })
  const ctx = audio()
  if (!ctx) return
  window.setTimeout(() => play({ from: 300, to: 200, duration: 0.18, gain: 0.045, type: 'sine' }), 95)
}

export function playFinish(): void {
  play({ from: 620, to: 660, duration: 0.11, gain: 0.05, type: 'sine' })
  const ctx = audio()
  if (!ctx) return
  window.setTimeout(() => play({ from: 830, to: 880, duration: 0.16, gain: 0.045, type: 'sine' }), 90)
}
