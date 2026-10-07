import { useSyncExternalStore } from 'react'

/**
 * iOS starts every AudioContext suspended and lets one run only from inside a
 * user gesture. The MoQ player makes its own contexts whenever it opens or
 * reopens the sound of a screen or a live, almost never inside a tap, so
 * every context made on this page is remembered and the next tap or key
 * anywhere resumes the ones still waiting.
 */
const contexts = new Set<AudioContext>()
// The app's own sounds (chimes, the onboarding, jlocal's feeds): resumed with the rest, but no stage waits on them.
const incidental = new WeakSet<AudioContext>()
const listeners = new Set<() => void>()
let installed = false

const notify = () => { for (const listener of listeners) listener() }

function resumeAll(): void {
  for (const context of contexts) {
    if (context.state === 'suspended') void context.resume().then(notify, () => undefined)
  }
}

export function installAudioUnlock(): void {
  if (installed || typeof window === 'undefined' || typeof window.AudioContext !== 'function') return
  installed = true
  const Native = window.AudioContext
  class Remembered extends Native {
    constructor(options?: AudioContextOptions) {
      super(options)
      contexts.add(this)
      this.addEventListener('statechange', () => {
        if (this.state === 'closed') contexts.delete(this)
        notify()
      })
      notify()
    }
  }
  window.AudioContext = Remembered
  // Touch grants a gesture on touchend and pointerup, not pointerdown; click follows both.
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const) {
    document.addEventListener(type, resumeAll, { capture: true, passive: true })
  }
}

/** Marks a context the app made for a sound of its own, which no stage waits on. */
export function incidentalAudio<T extends AudioContext>(context: T): T {
  incidental.add(context)
  return context
}

/** Whether a stage's sound is waiting for a tap to be allowed to play. */
export function audioLocked(): boolean {
  for (const context of contexts) if (context.state === 'suspended' && !incidental.has(context)) return true
  return false
}

export function useAudioLocked(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    audioLocked,
    () => false,
  )
}

/** For a button the viewer taps on purpose: the tap itself is the gesture. */
export function unlockAudio(): void {
  resumeAll()
}
