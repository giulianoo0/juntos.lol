import type { ReactNode } from 'react'
import { useHumanCheck } from '../human'
import { useT } from '../i18n/useT'
import { Tip } from './Tip'

/** Over the button that opens or enters a room, while the bot check runs. */
export function HumanTip({ children, block = false }: { children: ReactNode; block?: boolean }) {
  const t = useT()
  const checking = useHumanCheck()
  return <Tip label={t('human.checking')} open={checking} block={block}>{children}</Tip>
}
