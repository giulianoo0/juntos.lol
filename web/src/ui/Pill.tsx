import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { DiaText } from './Shimmer'
import { Spinner } from './Spinner'
import { Tip } from './Tip'
import styles from './Pill.module.css'

export type PillTone = 'primary' | 'brand' | 'soft' | 'danger' | 'glass'
export type PillSize = 'sm' | 'md' | 'lg'

interface PillOwn {
  tone?: PillTone
  /** sm 32px (header), md 36px, lg 44px (dock, forms). */
  size?: PillSize
  icon?: ReactNode
  /** Stretch to the row. */
  block?: boolean
  /** Working: the label runs the DiaShimmer and the button holds still. */
  loading?: boolean
  /** Waiting on something else (the bot check): a spinner where the icon
      goes, no shimmer, and the button still takes a click. */
  waiting?: boolean
}

function pillClass({ tone = 'soft', size = 'lg', block = false }: PillOwn, extra = ''): string {
  return [styles.pill, styles[tone], styles[size], block ? styles.block : '', extra].filter(Boolean).join(' ')
}

/** The rounded action: a pill with an optional icon before its words. */
export const Pill = forwardRef<HTMLButtonElement, PillOwn & ButtonHTMLAttributes<HTMLButtonElement>>(function Pill(
  { tone, size, icon, block, loading = false, waiting = false, className = '', type = 'button', disabled, children, ...rest },
  ref,
) {
  const mark = waiting && !loading ? <Spinner /> : icon
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || waiting || undefined}
      data-loading={loading || undefined}
      disabled={disabled || loading || waiting}
      className={pillClass({ tone, size, block }, className)}
      {...rest}
    >
      {mark ? <span className={styles.icon} aria-hidden="true">{mark}</span> : null}
      {loading ? <DiaText>{children}</DiaText> : children}
    </button>
  )
})

export function PillLink({ tone, size, icon, block, loading: _loading, waiting: _waiting, className = '', children, ...rest }: PillOwn & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={pillClass({ tone, size, block }, className)} {...rest}>
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {children}
    </a>
  )
}

interface RoundOwn {
  /** The accessible name and the hover tip. */
  label: string
  icon: ReactNode
  /** "off": the mic or camera turned off, in the danger tint. */
  state?: 'off' | 'on'
  tone?: 'soft' | 'primary' | 'scrim'
  size?: 'md' | 'lg'
}

/** The 44px round button of the dock: only an icon, named by `label`. */
export const RoundButton = forwardRef<HTMLButtonElement, RoundOwn & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>>(function RoundButton(
  { label, icon, state, tone = 'soft', size = 'lg', className = '', type = 'button', ...rest },
  ref,
) {
  // Only an icon: its name shows as the room's tooltip, not the browser's.
  return (
    <Tip
      label={label}
      render={(
        <button
          ref={ref}
          type={type}
          aria-label={label}
          data-state={state}
          className={[styles.round, styles[`round-${tone}`], styles[`round-${size}`], className].filter(Boolean).join(' ')}
          {...rest}
        >
          <span className={styles.icon} aria-hidden="true">{icon}</span>
        </button>
      )}
    />
  )
})
