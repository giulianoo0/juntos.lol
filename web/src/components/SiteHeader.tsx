import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AvatarFace } from '../account/AvatarFace'
import { discordLoginUrl, profilePath, useMe } from '../account'
import { NotificationBell } from '../account/NotificationBell'
import { useT } from '../i18n/useT'
import { HeroWordmark } from '../pages/home/Wordmark'
import { arrive } from '../ui/arrive'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { MorphLink } from '../ui/MorphLink'
import { Skeleton } from '../ui/Shimmer'
import { GithubLink } from '../ui/GithubLink'
import { ThemeToggle } from '../ui/ThemeToggle'
import styles from './SiteHeader.module.css'

/** The same top on every page outside a room: the logo home, which lights
    up with the DiaShimmer on hover, and you (or the way in) on the right, beside the light switch. */
export function SiteHeader({ logo = true, you = true }: {
  /** Off on the landing, where the big lettering is the logo and morphs into this one. */
  logo?: boolean
  /** Off where the page itself is you (your own account) or asks you in. */
  you?: boolean
}) {
  const t = useT()
  const { me, loading } = useMe()
  const location = useLocation()
  const [shine, setShine] = useState(false)
  return (
    <header className={styles.header}>
      {logo ? (
        <MorphLink
          className={styles.brand}
          to="/"
          state={{ morph: true }}
          aria-label="juntos.lol"
          onPointerEnter={() => setShine(true)}
          onPointerLeave={() => setShine(false)}
          onFocus={() => setShine(true)}
          onBlur={() => setShine(false)}
        >
          <HeroWordmark className={styles.mark} sweepClassName={styles.sweep} sweep={shine} />
        </MorphLink>
      ) : <span />}
      <div className={styles.you}>
        <GithubLink />
        <ThemeToggle />
        {me ? (
          <>
            <NotificationBell />
            {you ? (
              <MorphLink className={`${styles.me} ${arrive}`} to={profilePath(me.id)} aria-label={`${me.nickname} #${me.id}`}>
                <AvatarFace avatar={me.avatar} seed={me.id} size={32} />
                <span className={styles.number}>#{me.id}</span>
              </MorphLink>
            ) : null}
          </>
        ) : !you ? null : loading ? <Skeleton round width="7.5rem" height="var(--round-button)" /> : (
          <a className={`${styles.discord} ${arrive}`} href={discordLoginUrl(location.pathname)}>
            <DiscordGlyph size={18} />
            {t('landing.signIn')}
          </a>
        )}
      </div>
    </header>
  )
}
