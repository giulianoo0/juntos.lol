import { useState } from 'react'
import { Check, Volume2, VolumeX } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { fetchJLocalSoundApps, type JLocalAudioApp } from '../jlocal/audio'
import { setAppMuted, setSoundEnabled, useSoundChoice } from '../jlocal/soundChoice'
import { MorphingMenu } from '../ui/MorphingMenu'
import { Loading, Skeleton } from '../ui/Shimmer'
import { soundSummary, useAppSoundApps } from './appShare'
import { AppSoundSwitches, MuteAllButton } from './AppSound'

/**
 * Which sounds go out with a companion share: one switch for all of it, then
 * an app per row to leave out. The app list is asked for when the menu
 * opens, so it shows what is running now, not what was when the share began.
 * A desktop-app share (`app`) gets the picker's own switches instead, with
 * the apps' icons, and its trigger counts the apps going out.
 */
export function SoundMenu({ t, app = false }: { t: Translator; app?: boolean }) {
  return app ? <AppSoundMenu t={t} /> : <CompanionSoundMenu t={t} />
}

function AppSoundMenu({ t }: { t: Translator }) {
  const choice = useSoundChoice()
  const apps = useAppSoundApps(true)
  const summary = soundSummary(choice, apps, t)
  const silent = summary === t('jlocal.soundNone')
  return (
    <MorphingMenu
      align="start"
      haspopup="menu"
      minWidth={260}
      ariaLabel={t('appScreen.sound')}
      triggerClassName={`screen-quality-pill ${silent ? '' : 'is-on'}`}
      trigger={() => <>{silent ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}{summary}</>}
    >
      {() => (
        <div className="sound-menu app-sound-menu" role="group" aria-label={t('appScreen.sound')}>
          <div className="app-sound-menu-head">
            <strong>{t('appScreen.sound')}</strong>
            <MuteAllButton apps={apps} t={t} />
          </div>
          <AppSoundSwitches apps={apps} t={t} />
        </div>
      )}
    </MorphingMenu>
  )
}

function CompanionSoundMenu({ t }: { t: Translator }) {
  const choice = useSoundChoice()
  const [apps, setApps] = useState<JLocalAudioApp[] | null>(null)
  const load = () => {
    void fetchJLocalSoundApps().then((found) => setApps(found))
  }
  const excluded = choice.enabled ? choice.muted.length : 0
  const summary = !choice.enabled ? t('jlocal.soundNone')
    : excluded > 0 ? t('jlocal.soundSome').replace('{n}', String(excluded))
    : t('jlocal.soundAll')
  return (
    <MorphingMenu
      align="start"
      haspopup="menu"
      minWidth={220}
      ariaLabel={t('jlocal.soundApps')}
      triggerClassName={`screen-quality-pill ${choice.enabled ? 'is-on' : ''}`}
      trigger={() => <>{choice.enabled ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}{summary}</>}
      onOpen={load}
    >
      {() => (
        <div className="screen-quality-menu sound-menu" role="menu" aria-label={t('jlocal.soundApps')}>
          <button type="button" role="menuitemcheckbox" aria-checked={choice.enabled} onClick={() => setSoundEnabled(!choice.enabled)}>
            <strong>{t('jlocal.sound')}</strong>
            {choice.enabled ? <Check size={14} aria-hidden="true" /> : null}
          </button>
          {choice.enabled ? (
            <>
              <span className="sound-menu-hint">{t('jlocal.soundPick')}</span>
              {apps === null ? (
                <Loading label={t('status.loading')} className="sound-menu-skeleton">
                  <Skeleton width="70%" height="0.8rem" />
                  <Skeleton width="50%" height="0.8rem" />
                </Loading>
              )
                : apps.length === 0 ? <span className="sound-menu-hint">{t('jlocal.soundNoApps')}</span>
                : apps.map((app) => {
                  const on = !choice.muted.includes(app.id)
                  return (
                    <button key={app.id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => setAppMuted(app.id, on)}>
                      {app.name}
                      {on ? <Check size={14} aria-hidden="true" /> : null}
                    </button>
                  )
                })}
            </>
          ) : null}
        </div>
      )}
    </MorphingMenu>
  )
}
