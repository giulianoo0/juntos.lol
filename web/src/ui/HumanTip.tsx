import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactNode } from 'react'
import { useHumanCheck, useHumanPrecheck } from '../human'
import { useT } from '../i18n/useT'
import { CloudflareMark } from './CloudflareMark'
import spring from './SpringPopover.module.css'
import styles from './HumanTip.module.css'

/** Around a button that opens or enters a room. The bot check starts as soon
    as it is on screen; while it runs, hovering the button springs open what
    is going on. */
export function HumanTip({ children, block = false }: { children: ReactNode; block?: boolean }) {
  const t = useT()
  const checking = useHumanCheck()
  useHumanPrecheck()
  return (
    <Tooltip.Root disabled={!checking}>
      <Tooltip.Trigger delay={0} render={<span className={block ? styles.block : styles.trigger} />}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={8} className={styles.positioner}>
          <Tooltip.Popup className={`${spring.popup} ${styles.popup}`}>
            <p className={styles.title}>{t('human.checking')}</p>
            <p className={styles.credit}><CloudflareMark size={16} />by Cloudflare Turnstile</p>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
