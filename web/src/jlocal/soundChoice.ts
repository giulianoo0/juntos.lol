import { useSyncExternalStore } from 'react'
import { setJLocalAppMuted, setJLocalAudioMode, type JLocalAudioMode } from './audio'

/**
 * Which sounds a companion or desktop-app share carries: the whole mix,
 * nothing, or the mix minus the apps the person switched off. The choice
 * outlives one share (it is kept in storage) and is pushed to jlocal whenever
 * it changes, since jlocal keeps no memory of it across restarts. Every
 * Discord (the app, PTB, Canary, the other clients) starts off: the call
 * would come back to everyone in it as an echo.
 */
export interface SoundChoice {
  enabled: boolean
  /** App ids (jlocal's `/audio/apps`, the app's `audio_apps`) left out of the mix while `enabled`. */
  muted: readonly string[]
  /** Discords the person turned on anyway. */
  unmuted: readonly string[]
}

/** Mirrors `starts_muted` in the app (desktop/src-tauri/src/screen/mod.rs). */
const DISCORD_CLIENTS = ['discord', 'vesktop', 'legcord', 'armcord', 'webcord', 'equibop']

export function startsMuted(id: string): boolean {
  const lower = id.toLowerCase()
  return DISCORD_CLIENTS.some((client) => lower.includes(client))
}

export function isMuted(choice: SoundChoice, id: string): boolean {
  return choice.muted.includes(id) || (startsMuted(id) && !choice.unmuted.includes(id))
}

const STORAGE_KEY = 'ss.jlocal-sound.v1'
const DEFAULT_CHOICE: SoundChoice = { enabled: true, muted: [], unmuted: [] }

let current: SoundChoice = load()
const listeners = new Set<() => void>()

function load(): SoundChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CHOICE
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CHOICE
    const { enabled, muted, unmuted } = parsed as Record<string, unknown>
    const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    return { enabled: enabled !== false, muted: ids(muted), unmuted: ids(unmuted) }
  } catch {
    return DEFAULT_CHOICE
  }
}

function save(choice: SoundChoice): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)) } catch { /* nothing to do */ }
}

/** What jlocal, which knows nothing of Discords, is told to leave out. */
function jlocalMuted(choice: SoundChoice): string[] {
  return choice.unmuted.includes('discord') || choice.muted.includes('discord') ? [...choice.muted] : [...choice.muted, 'discord']
}

export function modeFor(choice: SoundChoice): JLocalAudioMode {
  if (!choice.enabled) return 'none'
  return jlocalMuted(choice).length > 0 ? 'custom' : 'all'
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
  for (const id of jlocalMuted(choice)) void setJLocalAppMuted(id, true)
}

export function setSoundChoice(next: SoundChoice): void {
  const before = jlocalMuted(current)
  current = { enabled: next.enabled, muted: [...next.muted], unmuted: [...next.unmuted] }
  save(current)
  const after = jlocalMuted(current)
  for (const id of before.filter((id) => !after.includes(id))) void setJLocalAppMuted(id, false)
  applySoundChoice(current)
  for (const listener of listeners) listener()
}

export function setSoundEnabled(enabled: boolean): void {
  setSoundChoice({ ...current, enabled })
}

export function setAppMuted(id: string, muted: boolean): void {
  const rest = current.muted.filter((other) => other !== id)
  if (startsMuted(id)) {
    const others = current.unmuted.filter((other) => other !== id)
    setSoundChoice({ ...current, muted: rest, unmuted: muted ? others : [...others, id] })
    return
  }
  setSoundChoice({ ...current, muted: muted ? [...rest, id] : rest })
}

/** Test-only reset. */
export function resetSoundChoiceForTests(): void {
  current = DEFAULT_CHOICE
  for (const listener of listeners) listener()
}
