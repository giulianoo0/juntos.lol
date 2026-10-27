import { Lock, Plus } from 'lucide-react'
import { useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { discordLoginUrl, useMe } from '../account'
import { AvatarFace } from '../account/AvatarFace'
import { useT } from '../i18n/useT'
import { Mascot } from '../mascot'
import { reactionSrc } from '../room/reactions'
import { roomCodeFrom } from '../roomCode'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { Field } from '../ui/Field'
import { IconPill } from '../ui/IconPill'
import { Pill, PillLink } from '../ui/Pill'
import { SpringPopover } from '../ui/SpringPopover'
import { Couch } from './home/Couch'
import { TurningTitle } from './home/TurningTitle'
import { HeroWordmark, SmallWordmark } from './home/Wordmark'
import styles from './Home.module.css'

const DISCORD_INSTALL = 'https://discord.com/oauth2/authorize?client_id=1564358804206911529'

export interface CreateRoomInput {
  name: string
  password: string
}

/* What a room can show, as stickers: each its own color and tilt. */
const SOURCES = [
  { key: 'Torrent', tone: 'amber', tilt: -3 },
  { key: 'YouTube', tone: 'red', tilt: 2 },
  { key: 'Drive', tone: 'blue', tilt: -2 },
  { key: 'landing.screen', tone: 'lilac', tilt: 3 },
  { key: 'landing.catalog', tone: 'mist', tilt: -1 },
] as const

/**
 * The landing: the shimmering lettering, "Bora <word> junto?", one big
 * "Criar sala" (a name and, behind the lock, a password; without an account
 * it offers Discord and goes on without one), a small field for a code, and
 * the crew on the couch.
 */
export function Home({ createRoom }: { createRoom: (input: CreateRoomInput) => Promise<{ roomID: string }> }) {
  const t = useT()
  const navigate = useNavigate()
  const { me, loading } = useMe()
  const [name, setName] = useState('')
  const [withPassword, setWithPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const room = roomCodeFrom(code)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const created = await createRoom({ name: name.trim(), password: withPassword ? password : '' })
      navigate(`/room/${created.roomID}`)
    } catch {
      setError(t('landing.failed'))
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/"><SmallWordmark className={styles.smallMark} /></a>
        {me ? (
          <Link className={styles.me} to="/conta" aria-label={`${me.nickname} #${me.id}`}>
            <AvatarFace avatar={me.avatar} seed={me.id} size={32} />
            <span className={styles.meNumber}>#{me.id}</span>
          </Link>
        ) : loading ? null : (
          <a className={styles.discord} href={discordLoginUrl('/')}>
            <DiscordGlyph size={18} />
            {t('landing.signIn')}
          </a>
        )}
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <HeroWordmark className={styles.heroMark} />
          <TurningTitle
            className={styles.title}
            before={t('landing.titleBefore')}
            after={t('landing.titleAfter')}
            words={t('landing.words').split(',')}
          />

          <div className={styles.actions}>
            <SpringPopover
              trigger={<><Plus size={22} strokeWidth={3} aria-hidden="true" />{t('landing.create')}</>}
              triggerClassName={styles.create}
              align="center"
              width="22rem"
              initialFocus={nameRef}
            >
              {() => (
                <form className={styles.form} onSubmit={(event) => { void create(event) }}>
                  <div className={styles.row}>
                    <Field
                      ref={nameRef}
                      aria-label={t('landing.roomName')}
                      placeholder={t('landing.roomName')}
                      value={name}
                      maxLength={80}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <IconPill
                      label={t('landing.password')}
                      icon={<Lock size={16} />}
                      active={withPassword}
                      aria-pressed={withPassword}
                      onClick={() => setWithPassword((on) => !on)}
                    />
                  </div>
                  {withPassword ? (
                    <div className={styles.reveal}>
                      <Field
                        type="password"
                        aria-label={t('landing.password')}
                        placeholder={t('landing.password')}
                        autoComplete="new-password"
                        autoFocus
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </div>
                  ) : null}
                  <Pill type="submit" tone="brand" size="lg" block disabled={busy}>
                    {me ? t('landing.go') : t('landing.continue')}
                  </Pill>
                  {me ? null : (
                    <PillLink tone="soft" size="md" block icon={<DiscordGlyph size={16} />} href={discordLoginUrl('/')}>
                      {t('landing.signIn')}
                    </PillLink>
                  )}
                  {error ? <p className={styles.error} role="alert">{error}</p> : null}
                </form>
              )}
            </SpringPopover>

            <form className={styles.join} onSubmit={(event) => { event.preventDefault(); if (room) navigate(`/room/${room}`) }}>
              <input
                className={styles.code}
                aria-label={t('landing.codeLabel')}
                placeholder={t('landing.code')}
                value={code}
                spellCheck={false}
                autoCapitalize="characters"
                autoCorrect="off"
                onChange={(event) => setCode(event.target.value)}
              />
              <Pill type="submit" tone="soft" size="sm" disabled={!room}>{t('landing.enter')}</Pill>
            </form>
          </div>

          <Couch />
        </section>

        <section className={styles.sources}>
          <div className={styles.sourcesInner}>
            <div className={styles.sourcesText}>
              <h2 className={styles.sourcesTitle}>{t('landing.sources')}</h2>
              <ul className={styles.stickers}>
                {SOURCES.map((source, index) => (
                  <li
                    key={source.key}
                    className={styles.sticker}
                    data-tone={source.tone}
                    style={{ '--tilt': `${source.tilt}deg`, '--delay': `${-index}s` } as CSSProperties}
                  >
                    {source.key.startsWith('landing.') ? t(source.key) : source.key}
                  </li>
                ))}
              </ul>
            </div>
            <RoomPreview />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <SmallWordmark className={styles.footerMark} />
        <PillLink tone="soft" size="md" icon={<Plus size={15} />} href={DISCORD_INSTALL} target="_blank" rel="noopener noreferrer">
          {t('landing.addDiscord')}
        </PillLink>
      </footer>
    </div>
  )
}

const voice = () => 0.5 + 0.5 * Math.sin(performance.now() / 140)

/** A room in miniature: the stage and three people beside it, one reacting. */
function RoomPreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.stage} />
      <div className={styles.tiles}>
        <div className={styles.tile}><Mascot kind="frog" accessory="none" expression="speaking" level={voice} size={64} /></div>
        <div className={styles.tile}>
          <img className={styles.tileBurst} src={reactionSrc('😂') ?? ''} alt="" width={26} height={26} />
          <Mascot kind="ghost" accessory="none" expression="happy" size={64} />
        </div>
        <div className={styles.tile}><Mascot kind="robot" accessory="headphones" expression="idle" size={64} /></div>
      </div>
    </div>
  )
}
