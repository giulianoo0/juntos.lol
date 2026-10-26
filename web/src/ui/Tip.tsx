import { Tooltip } from '@base-ui-components/react/tooltip'
import type { ReactElement, ReactNode } from 'react'
import styles from './Tip.module.css'

/**
 * A short name over an icon or an action, on hover and keyboard focus, at
 * once. The only place a word may sit beside a mark that does not say it.
 */
export function Tip({ label, children, render, side = 'top' }: {
  label: string
  children?: ReactNode
  /** The trigger itself (a button): it keeps its own name. */
  render?: ReactElement<Record<string, unknown>>
  side?: 'top' | 'bottom'
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={0} render={render ?? <span className={styles.trigger} aria-label={label} />}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} className={styles.positioner}>
          <Tooltip.Popup className={styles.tip}>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
