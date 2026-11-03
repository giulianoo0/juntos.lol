import { Check, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import type { SettingGroup } from '../player/Settings'
import styles from './tv.module.css'

/**
 * The player's subtitle, audio and quality choices as rows for the remote:
 * ↑ ↓ walk them, OK picks one. The pick is the player's own, as its menu does.
 */
export function TrackPanel({ groups, onClose }: { groups: SettingGroup[]; onClose: () => void }) {
  const t = useT()
  const shown = groups.filter((group) => group.options.length > 0)
  let first = true
  return (
    <div className={styles.panel} role="dialog" aria-label={t('tv.tracks')} data-tv-overlay="">
      <header className={styles.panelHeader}>
        <h2>{t('tv.tracks')}</h2>
        <button type="button" className={styles.roundButton} aria-label={t('home.closeDialog')} onClick={onClose}>
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      {shown.map((group) => (
        <section key={group.id} className={styles.trackGroup} aria-label={group.label}>
          <h3 className={styles.trackLabel}>{group.id === 'audio' ? t('tv.audioTrack') : group.label}</h3>
          {group.options.map((option) => {
            const current = option.value === group.current
            const focus = first && current
            if (focus) first = false
            return (
              <button
                key={option.value}
                type="button"
                className={styles.trackOption}
                aria-pressed={current}
                autoFocus={focus}
                onClick={() => group.onPick(option.value)}
              >
                <span>{option.label}</span>
                {current ? <Check size={24} aria-hidden="true" /> : null}
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}
