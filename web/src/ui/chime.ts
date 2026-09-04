/**
 * The room's small sounds: a two-note blip for someone arriving and a single
 * softer one for a message from someone else.
 *
 * Synthesised rather than fetched: each is an oscillator or two and an
 * envelope, so a sound file would be a network request, a hosting decision and
 * a licence for something describable in a dozen lines. It also means there is
 * nothing to fail to load at the moment it is supposed to play.
 */

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  context ??= new AudioContext()
  return context
}

interface Note {
  frequency: number
  startMs: number
  durationMs: number
  peak: number
}

/** Plays nothing before a gesture has unlocked audio, and nothing for a reader who asked for calm. */
function playNotes(notes: Note[]): void {
  const ctx = audio()
  if (!ctx || ctx.state !== 'running') { void ctx?.resume().catch(() => undefined); return }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  for (const { frequency, startMs, durationMs, peak } of notes) {
    const startsAt = ctx.currentTime + startMs / 1000
    const endsAt = startsAt + durationMs / 1000
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, startsAt)
    gain.gain.linearRampToValueAtTime(peak, startsAt + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start(startsAt)
    oscillator.stop(endsAt + 0.02)
  }
}

export function playJoinChime(): void {
  playNotes([
    { frequency: 659.25, startMs: 0, durationMs: 90, peak: 0.05 },
    { frequency: 987.77, startMs: 90, durationMs: 90, peak: 0.05 },
  ])
}

export function playMessageChime(): void {
  playNotes([{ frequency: 880, startMs: 0, durationMs: 70, peak: 0.035 }])
}
