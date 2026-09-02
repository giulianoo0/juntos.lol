/**
 * A two-note blip for someone arriving.
 *
 * Synthesised rather than fetched: it is two oscillators and an envelope, so a
 * sound file would be a network request, a hosting decision and a licence for
 * something describable in a dozen lines. It also means there is nothing to
 * fail to load at the moment it is supposed to play.
 */

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  context ??= new AudioContext()
  return context
}

const NOTES = [659.25, 987.77]
const NOTE_MS = 90
const PEAK = 0.05

export function playJoinChime(): void {
  const ctx = audio()
  if (!ctx || ctx.state !== 'running') { void ctx?.resume().catch(() => undefined); return }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  NOTES.forEach((frequency, index) => {
    const startsAt = ctx.currentTime + (index * NOTE_MS) / 1000
    const endsAt = startsAt + NOTE_MS / 1000
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, startsAt)
    gain.gain.linearRampToValueAtTime(PEAK, startsAt + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start(startsAt)
    oscillator.stop(endsAt + 0.02)
  })
}
