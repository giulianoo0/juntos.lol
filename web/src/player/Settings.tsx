import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Settings as SettingsIcon } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'

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

export interface SettingGroup {
  id: string
  label: string
  options: SettingOption[]
  current: number
  onPick: (value: number) => void
  /** Rows above the options that do something instead of picking a value. */
  actions?: SettingAction[]
  /** What the closed row reads when no option matches the current value. */
  valueLabel?: string
  /** A control of its own in place of the option list; stays open after use. */
  panel?: ReactNode
}

/**
 * Everything about how the room is being watched, in the button that opens it:
 * the gear widens into the panel rather than raising a second surface over it,
 * and groups expand where they stand instead of replacing each other.
 */
export const Settings = memo(function Settings({ groups, t }: { groups: SettingGroup[]; t: Translator }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const { shown, morphing } = useMorphingStep(open)
  useMorphingSize(boxRef, `${shown}:${expanded}`, { durationMs: 260, contentRef: paneRef })

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setExpanded(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  if (groups.length === 0) return null

  const label = t('room.settings')
  return (
    <div className="settings-control" ref={rootRef}>
      <div className={`settings-morph ${shown ? 'is-open' : ''}`} ref={boxRef}>
        <div className="settings-pane morph-fade" ref={paneRef} data-morphing={morphing}>
          {!shown ? (
            <button
              className="settings-trigger"
              aria-label={label}
              title={label}
              aria-expanded={open}
              onClick={() => setOpen(true)}
              onPointerUp={(event) => event.currentTarget.blur()}
            >
              <SettingsIcon size={16} />
            </button>
          ) : (
            <div className="settings-list">
              {groups.map((group) => {
                const isOpen = expanded === group.id
                const chosen = group.options.find((option) => option.value === group.current)
                return (
                  <div className="settings-group" key={group.id} data-testid={`setting-${group.id}`}>
                    <button
                      className="settings-row"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : group.id)}
                    >
                      <span className="settings-name">{group.label}</span>
                      <span className="settings-value">{chosen?.label ?? group.valueLabel ?? ''}</span>
                      <ChevronDown className="settings-chevron" size={14} aria-hidden="true" />
                    </button>
                    {isOpen ? (
                      <div className="settings-options">
                        {(group.actions ?? []).map((action) => (
                          <button
                            key={action.id}
                            className="settings-option settings-action"
                            onClick={() => { action.onSelect(); setExpanded(null) }}
                          >
                            {action.icon}
                            <span className="settings-option-label">{action.label}</span>
                          </button>
                        ))}
                        {group.panel}
                        {group.options.map((option) => (
                          <button
                            key={option.value}
                            className={`settings-option ${option.value === group.current ? 'is-current' : ''}`}
                            aria-pressed={option.value === group.current}
                            onClick={() => { group.onPick(option.value); setExpanded(null) }}
                          >
                            <span className="settings-option-label">{option.label}</span>
                            <Check className="settings-tick" size={14} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <span className="settings-slot" aria-hidden="true" />
    </div>
  )
})
