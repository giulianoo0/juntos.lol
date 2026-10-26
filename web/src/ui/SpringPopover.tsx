import { Popover } from '@base-ui-components/react/popover'
import { useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import styles from './SpringPopover.module.css'

export interface SpringPopoverProps {
  trigger?: ReactNode
  /** The trigger element itself (an `IconPill`), instead of a plain button. */
  triggerRender?: ReactElement<Record<string, unknown>>
  triggerClassName?: string
  /** The trigger's accessible name and hover tip, when it shows only an icon. */
  triggerLabel?: string
  triggerAttributes?: Record<`data-${string}`, string | undefined>
  /** The panel's heading; never a second line under it. */
  title?: string
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  popupClassName?: string
  /** The panel's width; 16rem by default. */
  width?: string
  initialFocus?: RefObject<HTMLElement | null>
  /** Controlled: the caller opens and closes it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: (api: { close: () => void }) => ReactNode
}

/**
 * The lawcore's spring popover: a frosted panel that springs out of its
 * trigger, from nothing and blurred to whole with a light bounce, and
 * settles back into it without one. Reduced motion: a plain fade.
 */
export function SpringPopover({
  trigger,
  triggerClassName,
  triggerRender,
  triggerLabel,
  triggerAttributes,
  title,
  align = 'start',
  side = 'bottom',
  popupClassName,
  width,
  initialFocus,
  open: controlled,
  onOpenChange,
  children,
}: SpringPopoverProps) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const change = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Trigger
        className={triggerClassName}
        render={triggerRender}
        aria-label={triggerLabel}
        title={triggerRender ? undefined : triggerLabel}
        {...triggerAttributes}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align={align} sideOffset={8} collisionPadding={16} className={styles.positioner}>
          <Popover.Popup
            className={popupClassName ? `${styles.popup} ${popupClassName}` : styles.popup}
            style={width ? { width } : undefined}
            {...(initialFocus ? { initialFocus } : {})}
          >
            {title ? <Popover.Title className={styles.title}>{title}</Popover.Title> : null}
            {children({ close: () => change(false) })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export interface SpringRowProps {
  /** The row's mark: a 16px icon in its rounded square, an avatar. */
  icon?: ReactNode
  label: string
  /** Present: a choice, checked or not. */
  checked?: boolean
  /** A destructive row (expulsar) in the danger ink. */
  tone?: 'danger'
  disabled?: boolean
  onSelect: () => void
}

/** A row of the popover: the mark, the label, the check. */
export function SpringRow({ icon, label, checked, tone, disabled, onSelect }: SpringRowProps) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={styles.row}
      data-tone={tone}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon ? <span className={styles.mark} aria-hidden="true">{icon}</span> : null}
      <span className={styles.label}>{label}</span>
      {checked ? (
        <svg className={styles.check} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
        </svg>
      ) : null}
    </button>
  )
}

/** A hairline between groups of rows. */
export function SpringRule() {
  return <div className={styles.rule} role="separator" />
}
