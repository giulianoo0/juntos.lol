import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './IconPill.module.css'

export interface IconPillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  /** The name: the accessible one, and what slides out on hover and focus. */
  label: string
  /** 'off': a mic or camera turned off, in the danger tint. */
  state?: 'off'
  /** Open or turned on (the panel, the password): the solid face. */
  active?: boolean
  size?: 'sm' | 'lg'
  /** Over a video: the dark glass. */
  tone?: 'soft' | 'scrim'
}

/**
 * The lawcore's expanding pill (`expanding-pill.tsx`): at rest a round
 * button with its icon alone; under the pointer or the focus its name
 * slides out and the face widens toward the inline start, over what is
 * beside it, so the row never moves. The name is the tip.
 */
export const IconPill = forwardRef<HTMLButtonElement, IconPillProps>(function IconPill(
  { icon, label, state, active = false, size = 'lg', tone = 'soft', className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-state={state}
      data-active={active || undefined}
      data-size={size}
      data-tone={tone}
      className={`${styles.pill} ${className}`.trim()}
      {...rest}
    >
      <span className={styles.face}>
        <span className={styles.icon} aria-hidden="true">{icon}</span>
        <span className={styles.label} aria-hidden="true">
          <span className={styles.labelText}>{label}</span>
        </span>
      </span>
    </button>
  )
})
