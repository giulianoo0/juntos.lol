import { MAX_LEVEL } from './VolumeSlider'

const STORAGE_KEY = 'ss.stage-volume'

/** The volume of a live or a shared screen, kept between rooms. */
export function loadStageVolume(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    if (localStorage.getItem(STORAGE_KEY) !== null && Number.isFinite(stored)) return Math.min(Math.max(stored, 0), MAX_LEVEL)
  } catch { /* nothing to do */ }
  return 1
}

export function saveStageVolume(volume: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(volume)) } catch { /* nothing to do */ }
}
