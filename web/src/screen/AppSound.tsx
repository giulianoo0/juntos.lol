import { Volume2 } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import type { AppAudioApp } from '../desktop/screen'
import { setAppMuted, setSoundChoice, setSoundEnabled, useSoundChoice } from '../jlocal/soundChoice'
import { Loading, Skeleton } from '../ui/Shimmer'
import { allSilent, isAppOn } from './appShare'
import styles from './AppSound.module.css'

/**
 * The sound of a desktop-app share, app by app: the same switches in the
 * picker's panel and in the live bar's popover, both writing the one sound
 * choice the share follows.
 */

export function MuteAllButton({ apps, t }: { apps: AppAudioApp[] | null; t: Translator }) {
  const choice = useSoundChoice()
  const silent = allSilent(choice, apps)
  return (
    <button
      type="button"
      className={styles.bulk}
      onClick={() => (silent ? setSoundChoice({ enabled: true, muted: [] }) : setSoundEnabled(false))}
    >
      {t(silent ? 'appScreen.unmuteAll' : 'appScreen.muteAll')}
    </button>
  )
}

/** One row per app with sound: its icon, its name and a switch. */
export function AppSoundSwitches({ apps, t }: { apps: AppAudioApp[] | null; t: Translator }) {
  const choice = useSoundChoice()
  const toggle = (id: string) => {
    // From total silence, one switch brings back that app alone.
    if (!choice.enabled) {
      const others = new Set([...choice.muted, ...(apps ?? []).map((app) => app.id)])
      others.delete(id)
      setSoundChoice({ enabled: true, muted: [...others] })
      return
    }
    setAppMuted(id, isAppOn(choice, id))
  }
  if (apps === null) {
    return (
      <Loading label={t('status.loading')} className={styles.loading}>
        <Skeleton width="70%" height="0.8rem" />
        <Skeleton width="50%" height="0.8rem" />
      </Loading>
    )
  }
  if (apps.length === 0) return <p className={styles.empty}>{t('appScreen.noApps')}</p>
  return (
    <ul className={styles.apps}>
      {apps.map((app) => (
        <li key={app.id}>
          <button type="button" role="switch" aria-checked={isAppOn(choice, app.id)} className={styles.app} onClick={() => toggle(app.id)}>
            {app.icon
              ? <img className={styles.icon} src={app.icon} alt="" aria-hidden="true" />
              : <span className={styles.icon} aria-hidden="true"><Volume2 size={14} /></span>}
            <span className={styles.name}>{app.name}</span>
            <span className={styles.switch} aria-hidden="true"><span className={styles.knob} /></span>
          </button>
        </li>
      ))}
    </ul>
  )
}
