import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'
import styles from './Tip.module.css'

/**
 * A short name over an icon or an action, on hover and keyboard focus, at
 * once. The only place a word may sit beside a mark that does not say it.
 */
export function Tip({ label, children, render, side = 'top', container, open, block = false }: {
  label: string
  children?: ReactNode
  /** The trigger itself (a button): it keeps its own name. */
  render?: ReactElement<Record<string, unknown>>
  side?: 'top' | 'bottom'
  /** Where the tip renders; inside a fullscreen element, that element. */
  container?: HTMLElement | null
  /** Shown while true and only then, whatever the pointer does. */
  open?: boolean
  /** The trigger spans its row, for a block button. */
  block?: boolean
}) {
  return (
    <Tooltip.Root open={open}>
      <Tooltip.Trigger delay={0} render={render ?? <span className={block ? styles.blockTrigger : styles.trigger} aria-label={open === undefined ? label : undefined} />}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal container={container ?? undefined}>
        <Tooltip.Positioner side={side} sideOffset={6} className={styles.positioner}>
          <Tooltip.Popup className={styles.tip}>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
