import { Lock, Plus } from 'lucide-react'
import { HumanTip } from '../ui/HumanTip'
import { usePublicConfig } from '../publicConfig'
import { HumanError, useHumanPrecheck } from '../human'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { discordLoginUrl, useMe } from '../account'
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
import { SiteHeader } from '../components/SiteHeader'
import { HeroWordmark, SmallWordmark } from './home/Wordmark'
import styles from './Home.module.css'

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
 * the crew on the couch. Signing in from the create panel comes back with
 * `?create=1` (and the name, and whether it had a password, never the
 * password itself) to finish what was started.
 */
export function Home({ createRoom }: { createRoom: (input: CreateRoomInput) => Promise<{ roomID: string }> }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { me, loading } = useMe()
  const config = usePublicConfig()
  useHumanPrecheck()
  const [name, setName] = useState('')
  const [withPassword, setWithPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useSearchParams()
  const resumed = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const room = roomCodeFrom(code)

  const submit = async (input: CreateRoomInput) => {
    setBusy(true)
    setError('')
    try {
      const created = await createRoom(input)
      navigate(`/room/${created.roomID}`)
    } catch (error) {
      setError(t(error instanceof HumanError ? 'human.failed' : 'landing.failed'))
      setBusy(false)
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    void submit({ name: name.trim(), password: withPassword ? password : '' })
  }

  // Back from Discord: create right away, unless the room had a password,
  // which has to be typed again. The ask leaves the address so a reload
  // does not make a second room.
  useEffect(() => {
    if (loading || resumed.current || search.get('create') !== '1') return
    resumed.current = true
    const back = search.get('name') ?? ''
    const locked = search.get('locked') === '1'
    setSearch({}, { replace: true })
    setName(back)
    setWithPassword(locked)
    setOpen(true)
    if (me && !locked) void submit({ name: back.trim(), password: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, me, search])

  const comeBack = new URLSearchParams({ create: '1' })
  if (name.trim()) comeBack.set('name', name.trim())
  if (withPassword) comeBack.set('locked', '1')
  // The server drops a way back longer than 512 bytes; a long name stays behind.
  if (`/?${comeBack}`.length > 500) comeBack.delete('name')

  return (
    <div className={styles.page}>
      <SiteHeader logo={false} />

      <main className={styles.main}>
        <section className={styles.hero}>
          <HeroWordmark className={styles.heroMark} morphed={Boolean((location.state as { morph?: boolean } | null)?.morph)} />
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
              open={open}
              onOpenChange={setOpen}
            >
              {() => (
                <form className={styles.form} onSubmit={create}>
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
                  <HumanTip block>
                    <Pill type="submit" tone="brand" size="lg" block loading={busy}>
                      {me ? t('landing.go') : t('landing.continue')}
                    </Pill>
                  </HumanTip>
                  {me ? null : (
                    <PillLink tone="soft" size="md" block icon={<DiscordGlyph size={16} />} href={discordLoginUrl(`/?${comeBack}`)}>
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
        {config?.discordAppId ? (
          <PillLink tone="soft" size="md" icon={<Plus size={15} />} href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.discordAppId)}`} target="_blank" rel="noopener noreferrer">
            {t('landing.addDiscord')}
          </PillLink>
        ) : null}
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
