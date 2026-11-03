import { LogOut, Tv, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AvatarFace } from '../account/AvatarFace'
import { discordLoginUrl, logout, profilePath, useMe } from '../account'
import { NotificationBell } from '../account/NotificationBell'
import { useT } from '../i18n/useT'
import { TravellingWordmark } from '../pages/home/Wordmark'
import { arrive } from '../ui/arrive'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { DownloadApp } from './DownloadApp'
import { Skeleton } from '../ui/Shimmer'
import { GithubLink } from '../ui/GithubLink'
import { SpringPopover, SpringRow, SpringRule } from '../ui/SpringPopover'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LinkTvDialog } from '../tvlink/LinkTvDialog'
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
  const navigate = useNavigate()
  const [shine, setShine] = useState(false)
  const [linking, setLinking] = useState(false)
  return (
    <header className={styles.header} data-tauri-drag-region>
      {logo ? (
        <Link
          className={styles.brand}
          to="/"
          aria-label="juntos.lol"
          onPointerEnter={() => setShine(true)}
          onPointerLeave={() => setShine(false)}
          onFocus={() => setShine(true)}
          onBlur={() => setShine(false)}
        >
          <TravellingWordmark className={styles.mark} sweepClassName={styles.sweep} sweep={shine} />
        </Link>
      ) : <span />}
      <div className={styles.you}>
        <DownloadApp />
        <span className={styles.github}><GithubLink /></span>
        <ThemeToggle />
        {me ? (
          <>
            <NotificationBell />
            {you ? (
              <SpringPopover
                triggerRender={<button type="button" className={`${styles.me} ${arrive}`} />}
                trigger={(
                  <>
                    <AvatarFace avatar={me.avatar} seed={me.id} size={32} />
                    <span className={styles.number}>#{me.id}</span>
                  </>
                )}
                triggerLabel={`${me.nickname} #${me.id}`}
                align="end"
                width="14rem"
              >
                {({ close }) => (
                  <div role="menu" aria-label={t('account.menu')}>
                    <SpringRow icon={<UserRound size={16} />} label={t('account.viewProfile')} onSelect={() => { close(); navigate(profilePath(me.id)) }} />
                    <SpringRow icon={<Tv size={16} />} label={t('tv.link')} onSelect={() => { close(); setLinking(true) }} />
                    <SpringRule />
                    <SpringRow icon={<LogOut size={16} />} label={t('account.logout')} onSelect={() => { close(); navigate('/'); void logout().catch(() => undefined) }} />
                  </div>
                )}
              </SpringPopover>
            ) : null}
          </>
        ) : !you ? null : loading ? <Skeleton round width="7.5rem" height="var(--round-button)" /> : (
          <a className={`${styles.discord} ${arrive}`} href={discordLoginUrl(location.pathname)} aria-label={t('landing.signIn')}>
            <DiscordGlyph size={18} />
            <span className={styles.discordLabel}>{t('landing.signIn')}</span>
          </a>
        )}
      </div>
      <LinkTvDialog open={linking} onOpenChange={setLinking} />
    </header>
  )
}
