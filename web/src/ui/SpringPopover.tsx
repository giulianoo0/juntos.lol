import { Popover } from '@base-ui-components/react/popover'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type TransitionEvent,
} from 'react'
import styles from './SpringPopover.module.css'

/** When the settle never reports its end (a background tab, a test):
    `--duration-spring-settle` and a little more. */
const SETTLE_FALLBACK_MS = 420

export interface SpringPresence<T extends HTMLElement> {
  /** Render the popup while this is true: from the opening to the settle. */
  present: boolean
  ref: RefObject<T | null>
  /** Spread on the popup (it carries the `spring` class). */
  props: {
    'data-ending-style': '' | undefined
    // React 18 drops a boolean `inert`; the empty string is the attribute.
    inert: '' | undefined
    onTransitionEnd: (event: TransitionEvent<T>) => void
  }
}

/**
 * Base UI's `data-starting-style` / `data-ending-style` for a popup of its
 * own (the person's menu, a tile's card): it mounts closed, springs open on
 * the next frame and stays mounted, inert, until it has settled back. The
 * popup carries `springClass` and its own `--transform-origin`.
 */
export function useSpringPresence<T extends HTMLElement>(open: boolean, identity?: string | null): SpringPresence<T> {
  const ref = useRef<T>(null)
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const ending = present && !open

  // Born closed: the closed style is computed once (the forced layout), then
  // dropped, and the spring runs from there.
  useLayoutEffect(() => {
    const popup = ref.current
    if (!present || !popup || ending) return
    popup.setAttribute('data-starting-style', '')
    void popup.offsetWidth
    popup.removeAttribute('data-starting-style')
    // `ending` only gates: a popup reopened mid-settle continues from where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, identity])

  useEffect(() => {
    if (!ending) return undefined
    const timer = window.setTimeout(() => setPresent(false), SETTLE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [ending])

  return {
    present,
    ref,
    props: {
      'data-ending-style': ending ? '' : undefined,
      inert: ending ? '' : undefined,
      onTransitionEnd: (event) => {
        if (!ending || event.target !== event.currentTarget) return
        // `scale` with the spring; `opacity` with reduced motion.
        if (event.propertyName === 'scale' || event.propertyName === 'opacity') setPresent(false)
      },
    },
  }
}

/** The spring alone, for a popup with a look of its own. */
export const springClass = styles.spring

export interface SpringPopoverProps {
  trigger: ReactNode
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
        aria-label={triggerLabel}
        title={triggerLabel}
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
