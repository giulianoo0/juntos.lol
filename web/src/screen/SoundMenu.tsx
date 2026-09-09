import { useState } from 'react'
import { Check, Volume2, VolumeX } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { fetchJLocalSoundApps, type JLocalAudioApp } from '../jlocal/audio'
import { setAppMuted, setSoundEnabled, useSoundChoice } from '../jlocal/soundChoice'
import { MorphingMenu } from '../ui/MorphingMenu'

/**
 * Which sounds go out with a companion share: one switch for all of it, then
 * an app per row to leave out. The app list is asked for when the menu
 * opens, so it shows what is running now, not what was when the share began.
 */
export function SoundMenu({ t }: { t: Translator }) {
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
              {apps === null ? <span className="sound-menu-hint">{t('jlocal.loading')}</span>
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
