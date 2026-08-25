import { memo, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Settings as SettingsIcon } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'

export interface SettingOption {
  /** Stable identity of the choice, independent of where it sits in the list. */
  value: number
  label: string
}

export interface SettingGroup {
  /** Used for the group's test id and its React key. */
  id: string
  label: string
  options: SettingOption[]
  current: number
  onPick: (value: number) => void
}

/**
 * Everything about how the room is being watched, in the button that opens it.
 *
 * The box is the control: closed it is the round gear in the bar, and opening
 * it widens and deepens that same box into the panel rather than raising a
 * second surface over it. It is taken out of the bar's flow so growing costs
 * the other controls no room, and anchored bottom-right so it grows up and to
 * the left, away from the edge it sits on.
 *
 * Groups expand where they stand: opening subtitles must not take audio and
 * quality off screen, or the settings stop being one surface and become a
 * stack of menus.
 */
export const Settings = memo(function Settings({ groups, t }: { groups: SettingGroup[]; t: Translator }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const { shown, morphing } = useMorphingStep(open)
  useMorphingSize(boxRef, `${shown}:${expanded}`, { durationMs: 260, contentRef: paneRef })

  // Settings laid over the picture get out of the way the moment attention
  // moves back to it. pointerdown rather than click, so it closes on the press
  // that started elsewhere instead of waiting for the release.
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
            // Bare on purpose: the circle it looks like is the panel's own
            // border and background, so opening it grows that same box.
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
                      <span className="settings-value">{chosen?.label ?? ''}</span>
                      <ChevronDown className="settings-chevron" size={14} aria-hidden="true" />
                    </button>
                    {isOpen ? (
                      <div className="settings-options">
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
      {/* Holds the gear's place in the bar while the box above it grows out
          of flow, so opening the settings never shifts the other controls. */}
      <span className="settings-slot" aria-hidden="true" />
    </div>
  )
})
