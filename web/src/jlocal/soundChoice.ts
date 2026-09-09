import { useSyncExternalStore } from 'react'
import { setJLocalAppMuted, setJLocalAudioMode, type JLocalAudioMode } from './audio'

/**
 * Which sounds a companion share carries: the whole mix, nothing, or the mix
 * minus the apps the person switched off. The choice outlives one share (it
 * is kept in storage) and is pushed to the app whenever it changes, since the
 * app keeps no memory of it across restarts.
 */
export interface SoundChoice {
  enabled: boolean
  /** App ids (`/audio/apps`) left out of the mix while `enabled`. */
  muted: readonly string[]
}

const STORAGE_KEY = 'ss.jlocal-sound.v1'
const DEFAULT_CHOICE: SoundChoice = { enabled: true, muted: [] }

let current: SoundChoice = load()
const listeners = new Set<() => void>()

function load(): SoundChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CHOICE
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CHOICE
    const { enabled, muted } = parsed as Record<string, unknown>
    return {
      enabled: enabled !== false,
      muted: Array.isArray(muted) ? muted.filter((id): id is string => typeof id === 'string') : [],
    }
  } catch {
    return DEFAULT_CHOICE
  }
}

function save(choice: SoundChoice): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)) } catch { /* nothing to do */ }
}

export function modeFor(choice: SoundChoice): JLocalAudioMode {
  if (!choice.enabled) return 'none'
  return choice.muted.length > 0 ? 'custom' : 'all'
}

export function getSoundChoice(): SoundChoice {
  return current
}

export function subscribeSoundChoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useSoundChoice(): SoundChoice {
  return useSyncExternalStore(subscribeSoundChoice, getSoundChoice, getSoundChoice)
}

/** Tells the app the whole choice, mode and every mute; safe to call any time. */
export function applySoundChoice(choice: SoundChoice = current): void {
  void setJLocalAudioMode(modeFor(choice))
  for (const id of choice.muted) void setJLocalAppMuted(id, true)
}

export function setSoundChoice(next: SoundChoice): void {
  const unmuted = current.muted.filter((id) => !next.muted.includes(id))
  current = { enabled: next.enabled, muted: [...next.muted] }
  save(current)
  for (const id of unmuted) void setJLocalAppMuted(id, false)
  applySoundChoice(current)
  for (const listener of listeners) listener()
}

export function setSoundEnabled(enabled: boolean): void {
  setSoundChoice({ ...current, enabled })
}

export function setAppMuted(id: string, muted: boolean): void {
  const rest = current.muted.filter((other) => other !== id)
  setSoundChoice({ ...current, muted: muted ? [...rest, id] : rest })
}

/** Test-only reset. */
export function resetSoundChoiceForTests(): void {
  current = DEFAULT_CHOICE
  for (const listener of listeners) listener()
}
