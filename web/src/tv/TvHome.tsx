import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { HeroWordmark } from '../pages/home/Wordmark'
import { Face } from '../room/ui/Face'
import { fetchTvFriends, tvDiscordAvatar, type TvAccount, type TvFriend } from './api'
import styles from './TvHome.module.css'

const FRIENDS_MS = 30_000

type Where = 'room' | 'juntos' | 'discord' | 'away'

function whereOf(friend: TvFriend): Where {
  if (friend.presence.inRoom) return 'room'
  if (friend.presence.online) return 'juntos'
  if (friend.presence.discord && friend.presence.discord !== 'offline') return 'discord'
  return 'away'
}

const rank: Record<Where, number> = { room: 0, juntos: 1, discord: 2, away: 3 }

function greeting(t: ReturnType<typeof useT>, hour: number): string {
  if (hour < 5 || hour >= 18) return t('tv.goodEvening')
  if (hour < 12) return t('tv.goodMorning')
  return t('tv.goodAfternoon')
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** The TV at rest, as a TV's own home: the time and who it belongs to, a greeting, and the friends who are around. */
export function TvHome({ account, token }: { account: TvAccount; token: string }) {
  const t = useT()
  const now = useClock()
  const [friends, setFriends] = useState<TvFriend[]>([])

  useEffect(() => {
    let live = true
    const load = () => {
      fetchTvFriends(token)
        .then((next) => { if (live) setFriends(next.filter((f) => whereOf(f) !== 'away').sort((a, b) => rank[whereOf(a)] - rank[whereOf(b)])) })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, FRIENDS_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [token])

  const time = now.toLocaleTimeString(t.language, { hour: '2-digit', minute: '2-digit' })
  const firstName = account.nickname.split(' ')[0]
  return (
    <main className={styles.home}>
      <div className={styles.glow} aria-hidden="true" />
      <header className={styles.top}>
        <HeroWordmark className={styles.mark} sweep={false} />
        <div className={styles.topEnd}>
          <span className={styles.clock}>{time}</span>
          <span className={styles.me}>
            <Face id={String(account.id)} avatar={account.avatar} size={44} still />
            <span className={styles.meName}>{account.nickname}</span>
          </span>
        </div>
      </header>

      <section className={styles.hero} data-alone={friends.length === 0 || undefined}>
        <div className={styles.heroFace}>
          <Face id={String(account.id)} avatar={account.avatar} size={friends.length === 0 ? 300 : 220} still={false} />
        </div>
        <h1 className={styles.greeting}>{greeting(t, now.getHours()).replace('{name}', firstName)}</h1>
      </section>

      {friends.length > 0 ? (
        <section className={styles.shelf} aria-label={t('social.online')}>
          <h2 className={styles.shelfTitle}>{t('social.online')}</h2>
          <ul className={styles.row}>
            {friends.map((friend, index) => (
              <li key={friend.id} className={styles.cell} style={{ animationDelay: `${120 + index * 60}ms` }}>
                <FriendCard friend={friend} token={token} autoFocus={index === 0} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}

function FriendCard({ friend, token, autoFocus }: { friend: TvFriend; token: string; autoFocus: boolean }) {
  const t = useT()
  const where = whereOf(friend)
  const [picture, setPicture] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    let url: string | null = null
    tvDiscordAvatar(token, friend.id).then((next) => {
      url = next
      if (live) setPicture(next)
      else if (next) URL.revokeObjectURL(next)
    }).catch(() => undefined)
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [token, friend.id])

  useEffect(() => {
    if (autoFocus && (!document.activeElement || document.activeElement === document.body)) ref.current?.focus()
  }, [autoFocus])

  const label = where === 'room'
    ? (friend.presence.roomName ? t('social.inRoomNamed').replace('{room}', friend.presence.roomName) : t('social.inRoom'))
    : where === 'juntos' ? t('social.onJuntos')
    : friend.presence.discord === 'idle' ? t('social.idle')
    : friend.presence.discord === 'dnd' ? t('social.dnd') : t('social.onDiscord')

  return (
    <button ref={ref} type="button" className={styles.card} data-where={where} aria-label={`${friend.nickname}, ${label}`}>
      <span className={styles.cardFace}>
        <Face id={String(friend.id)} avatar={friend.avatar} size={132} still={where !== 'room' && where !== 'juntos'} />
        {picture ? (
          <span className={styles.discord} data-status={friend.presence.discord ?? 'offline'}>
            <img src={picture} alt="" />
            <span className={styles.dot} />
          </span>
        ) : null}
      </span>
      <span className={styles.cardName}>{friend.nickname}</span>
      <span className={styles.badge} data-where={where} aria-hidden="true" />
    </button>
  )
}
