import type { ReactNode } from 'react'
import { Mascot } from '../mascot'
import { avatarOf } from '../room/avatar'
import { arrive } from '../ui/arrive'
import { useT } from '../i18n/useT'
import { PillLink } from '../ui/Pill'
import { SiteHeader } from './SiteHeader'
import styles from './LostPage.module.css'

/** Nothing here: a puzzled creature in the middle of the page, what is missing, and a way on. */
export function LostPage({ title, action, seed = 'lost' }: { title: string; action: ReactNode; seed?: string }) {
  const spec = avatarOf(undefined, seed)
  return (
    <div className={`${styles.lost} ${arrive}`}>
      <div className={styles.bob}>
        <Mascot kind={spec.kind} accessory={spec.accessory} expression="thinking" size={132} />
      </div>
      <h1 className={styles.title}>{title}</h1>
      {action}
    </div>
  )
}

/** A page of its own for an address that leads nowhere: the header, and the way home. */
export function NotFoundPage({ title }: { title?: string }) {
  const t = useT()
  return (
    <div className={styles.page}>
      <SiteHeader />
      <LostPage title={title ?? t('lost.page')} action={<PillLink tone="brand" size="lg" href="/">{t('lost.home')}</PillLink>} />
    </div>
  )
}
