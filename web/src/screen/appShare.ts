import { useEffect, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { appAudioApps, type AppAudioApp } from '../desktop/screen'
import { isMuted, type SoundChoice } from '../jlocal/soundChoice'
import { loadScreenQuality, SCREEN_QUALITIES, type ScreenQualityId } from '../screenshare'

/** The list of sounding apps follows the machine at this pace while someone looks at it. */
const REFRESH_MS = 2_000

/** The app's quality presets: every fixed rung, since the app re-sizes on the GPU. */
export const APP_QUALITIES: ScreenQualityId[] = SCREEN_QUALITIES.filter((quality) => quality.width !== undefined).map((quality) => quality.id)

export function initialAppQuality(): ScreenQualityId {
  const saved = loadScreenQuality()
  return APP_QUALITIES.includes(saved) ? saved : '1080p60'
}

/** The apps making sound now, asked again every couple of seconds while `active`. */
export function useAppSoundApps(active: boolean): AppAudioApp[] | null {
  const [apps, setApps] = useState<AppAudioApp[] | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      void appAudioApps().then((found) => { if (!cancelled) setApps(found) })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active])
  return apps
}

export const isAppOn = (choice: SoundChoice, id: string) => choice.enabled && !isMuted(choice, id)

/** Whether nothing listed is going out, so the bulk button turns everything back on. */
export function allSilent(choice: SoundChoice, apps: AppAudioApp[] | null): boolean {
  if (!choice.enabled) return true
  return apps !== null && apps.length > 0 && apps.every((app) => !isAppOn(choice, app.id))
}

/** "3 apps", "1 app" or "Sem som": what the live bar says the share carries. */
export function soundSummary(choice: SoundChoice, apps: AppAudioApp[] | null, t: Translator): string {
  const on = apps?.filter((app) => isAppOn(choice, app.id)).length ?? 0
  if (!choice.enabled || (apps !== null && on === 0)) return t('jlocal.soundNone')
  if (apps === null) return t('appScreen.sound')
  return on === 1 ? t('appScreen.oneApp') : t('appScreen.apps').replace('{n}', String(on))
}
