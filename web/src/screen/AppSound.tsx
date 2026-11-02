import { Search, Volume2 } from 'lucide-react'
import { useState } from 'react'
import type { Translator } from '../i18n/useT'
import type { AppAudioApp } from '../desktop/screen'
import { setAppMuted, setSoundChoice, setSoundEnabled, startsMuted, useSoundChoice } from '../jlocal/soundChoice'
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
      onClick={() => (silent
        ? setSoundChoice({ enabled: true, muted: [], unmuted: (apps ?? []).map((app) => app.id).filter(startsMuted) })
        : setSoundEnabled(false))}
    >
      {t(silent ? 'appScreen.unmuteAll' : 'appScreen.muteAll')}
    </button>
  )
}

/** Past this many apps the list gets a search field. */
const SEARCH_FROM = 7

/** Case, accents and the marks some apps put in their names do not count. */
function folded(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f\u200e\u200f]/g, '').toLowerCase().trim()
}

export function matchingApps(apps: AppAudioApp[], query: string): AppAudioApp[] {
  const wanted = folded(query)
  return wanted ? apps.filter((app) => folded(app.name).includes(wanted)) : apps
}

/** One row per app with sound: its icon, its name and a switch. */
export function AppSoundSwitches({ apps, t }: { apps: AppAudioApp[] | null; t: Translator }) {
  const choice = useSoundChoice()
  const [query, setQuery] = useState('')
  const toggle = (id: string) => {
    // From total silence, one switch brings back that app alone.
    if (!choice.enabled) {
      const others = new Set([...choice.muted, ...(apps ?? []).map((app) => app.id)])
      others.delete(id)
      setSoundChoice({ enabled: true, muted: [...others], unmuted: startsMuted(id) ? [...choice.unmuted, id] : choice.unmuted })
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
  const shown = matchingApps(apps, query)
  return (
    <div className={styles.switches}>
      {apps.length >= SEARCH_FROM ? (
        <label className={styles.search}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('appScreen.search')}
            aria-label={t('appScreen.searchApps')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      {shown.length === 0 ? <p className={styles.empty}>{t('appScreen.noMatch')}</p> : (
        <ul className={styles.apps}>
          {shown.map((app) => (
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
      )}
    </div>
  )
}
