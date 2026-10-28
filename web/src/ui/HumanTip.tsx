import type { ReactNode } from 'react'
import { useHumanCheck, useHumanPrecheck } from '../human'
import { useT } from '../i18n/useT'
import { CloudflareMark } from './CloudflareMark'
import { Tip } from './Tip'

/** Over the button that opens or enters a room, while the bot check runs,
    which starts as soon as the button is on screen. */
export function HumanTip({ children, block = false }: { children: ReactNode; block?: boolean }) {
  const t = useT()
  const checking = useHumanCheck()
  useHumanPrecheck()
  return (
    <Tip
      label={t('human.checking')}
      detail={<><CloudflareMark size={14} />by Cloudflare Turnstile</>}
      open={checking}
      block={block}
    >
      {children}
    </Tip>
  )
}
