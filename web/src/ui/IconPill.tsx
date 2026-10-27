import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { DiaGlyph } from './Shimmer'
import { Tip } from './Tip'
import styles from './IconPill.module.css'

export interface IconPillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  /** The name: the accessible one, and the tip on hover and focus. */
  label: string
  /** 'off': a mic or camera turned off, in the danger tint. */
  state?: 'off'
  /** Open or turned on (the panel, the password): the solid face. */
  active?: boolean
  size?: 'sm' | 'lg'
  /** Working: the icon runs the DiaShimmer's colours and the button holds still. */
  loading?: boolean
  /** Over a video: the dark glass. */
  tone?: 'soft' | 'scrim'
}

/**
 * A round button with its icon alone; its name shows as the room's tip.
 * The hover only tints the face: nothing grows or moves its neighbours.
 */
export const IconPill = forwardRef<HTMLButtonElement, IconPillProps>(function IconPill(
  { icon, label, state, active = false, size = 'lg', tone = 'soft', loading = false, className = '', type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <Tip
      label={label}
      render={(
        <button
          ref={ref}
          type={type}
          aria-label={label}
          data-state={state}
          data-active={active || undefined}
          data-size={size}
          data-tone={tone}
          aria-busy={loading || undefined}
          disabled={disabled || loading}
          className={`${styles.pill} ${className}`.trim()}
          {...rest}
        >
          <span className={styles.icon} aria-hidden="true">{loading ? <DiaGlyph>{icon}</DiaGlyph> : icon}</span>
        </button>
      )}
    />
  )
})
