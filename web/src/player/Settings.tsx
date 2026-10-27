import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Settings as SettingsIcon } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { MorphSize } from '../ui/MorphSize'
import { Segmented } from '../ui/Segmented'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import styles from './Settings.module.css'

export interface SettingOption {
  value: number
  label: string
}

export interface SettingAction {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
}

/** Which of the two tabs a group lives in. */
export type SettingTab = 'audio' | 'subtitles'

export interface SettingGroup {
  id: string
  tab: SettingTab
  label: string
  options: SettingOption[]
  current: number
  onPick: (value: number) => void
  /** Rows above the options that do something instead of picking a value. */
  actions?: SettingAction[]
  /** What the closed row reads when no option matches the current value. */
  valueLabel?: string
  /** A control of its own beside the group's name, in place of the options. */
  panel?: ReactNode
}

function Group({ group, headed }: { group: SettingGroup; headed: boolean }) {
  if (group.panel) {
    return (
      <div className={styles.row} data-testid={`setting-${group.id}`}>
        <span className={styles.rowLabel}>{group.label}</span>
        <div className={styles.rowControl}>{group.panel}</div>
      </div>
    )
  }
  return (
    <div className={styles.group} role="group" aria-label={group.label} data-testid={`setting-${group.id}`}>
      {headed ? <span className={styles.heading}>{group.label}</span> : null}
      {group.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.option}
          aria-pressed={option.value === group.current}
          onClick={() => group.onPick(option.value)}
        >
          <span className={styles.optionLabel}>{option.label}</span>
          <Check className={styles.tick} size={16} strokeWidth={2.5} aria-hidden="true" />
        </button>
      ))}
      {(group.actions ?? []).map((action) => (
        <button key={action.id} type="button" className={`${styles.option} ${styles.action}`} onClick={action.onSelect}>
          {action.icon}
          <span className={styles.optionLabel}>{action.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Everything about how the room is being watched, in the button that opens it:
 * the gear widens into the panel rather than raising a second surface over it.
 * Inside, Áudio and Legendas trade places through a short blur while the
 * panel follows the new height.
 */
export const Settings = memo(function Settings({ groups, t }: { groups: SettingGroup[]; t: Translator }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SettingTab>('subtitles')
  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const { shown, morphing } = useMorphingStep(open)
  useMorphingSize(boxRef, shown, { durationMs: 260 })

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  if (groups.length === 0) return null

  const tabs = (['audio', 'subtitles'] as const).filter((name) => groups.some((group) => group.tab === name))
  const current = tabs.includes(tab) ? tab : tabs[0] ?? 'subtitles'
  const inTab = groups.filter((group) => group.tab === current)
  const lists = inTab.filter((group) => !group.panel).length

  const label = t('room.settings')
  return (
    <div className="settings-control" ref={rootRef} data-tip={open ? undefined : label}>
      <div className={`settings-morph ${shown ? 'is-open' : ''}`} ref={boxRef}>
        <div className="settings-pane morph-fade" data-morphing={morphing}>
          {!shown ? (
            <button
              className="settings-trigger"
              aria-label={label}
              aria-expanded={open}
              onClick={() => setOpen(true)}
              onPointerUp={(event) => event.currentTarget.blur()}
            >
              <SettingsIcon size={16} />
            </button>
          ) : (
            <div className={styles.panel}>
              {tabs.length > 1 ? (
                <Segmented
                  className={styles.tabs}
                  label={label}
                  options={[
                    { value: 'audio', label: t('room.audio') },
                    { value: 'subtitles', label: t('room.subtitles') },
                  ]}
                  value={current}
                  onChange={setTab}
                />
              ) : null}
              <MorphSize step={current} axis="height">
                <div className={styles.view}>
                  {inTab.map((group) => <Group key={group.id} group={group} headed={!group.panel && lists > 1} />)}
                </div>
              </MorphSize>
            </div>
          )}
        </div>
      </div>
      <span className="settings-slot" aria-hidden="true" />
    </div>
  )
})
