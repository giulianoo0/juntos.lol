import { Check, Clock, Film, Lock, LogOut, Monitor, Pencil, Plus, Radio, Send, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  acceptFriend,
  discordLoginUrl,
  dropFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  fetchHistory,
  fetchProfile,
  inviteFriend,
  InviteError,
  logout,
  requestFriend,
  updateMe,
  useMe,
  type AccountCard,
  type AccountStats,
  type Friend,
  type FriendRequests,
  type HistoryEntry,
  type Me,
  type Profile,
  type Visibility,
} from '../account'
import { AvatarEditor } from '../account/AvatarEditor'
import { AvatarFace } from '../account/AvatarFace'
import { useT, type Translator } from '../i18n/useT'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { Field } from '../ui/Field'
import { hueOf } from '../ui/hue'
import { IconPill } from '../ui/IconPill'
import { Modal } from '../ui/Modal'
import { Pill } from '../ui/Pill'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Shimmer'
import { SpringPopover } from '../ui/SpringPopover'
import { Tip } from '../ui/Tip'
import { useToast } from '../ui/toastContext'
import { SmallWordmark } from './home/Wordmark'
import styles from './Account.module.css'

const errorText: Record<string, string> = {
  user_not_found: 'account.userNotFound',
  invalid_friend: 'account.invalidFriend',
  too_many_requests: 'account.tooMany',
}

const inviteErrorText: Record<string, string> = {
  not_in_room: 'account.inviteNotInRoom',
  invites_disabled: 'account.inviteDisabled',
  too_many_invites: 'account.inviteTooMany',
}

/** "hoje", "ontem", the weekday within a week, then the day and month. */
function whenLabel(iso: string, t: Translator, now = new Date()): string {
  const then = new Date(iso)
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((day(now) - day(then)) / 86_400_000)
  if (days <= 0) return t('account.today')
  if (days === 1) return t('account.yesterday')
  if (days < 7) return then.toLocaleDateString(t.language, { weekday: 'long' })
  return then.toLocaleDateString(t.language, { day: 'numeric', month: 'short' })
}

const stagger = (index: number) => ({ '--i': index }) as CSSProperties

/**
 * An account: `/conta` is one's own (nickname, avatar, friends, who sees
 * the history, sign out), `/u/:id` anyone's, as much as they show.
 */
export function AccountPage() {
  const t = useT()
  const { id: param } = useParams()
  const { me, loading } = useMe()
  const wanted = param === undefined ? null : Number(param)

  let body: ReactNode = null
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 1)) {
    body = <Empty icon={<X size={28} />} title={t('account.notFound')} />
  } else if (loading) {
    body = <AccountSkeleton panels />
  } else if (me && (wanted === null || wanted === me.id)) {
    body = <OwnAccount me={me} />
  } else if (wanted !== null) {
    body = <OtherAccount id={wanted} />
  } else {
    body = (
      <div className={styles.signedOut}>
        <h1 className={styles.signedOutTitle}>{t('account.yours')}</h1>
        <a className={styles.discord} href={discordLoginUrl('/conta')}>
          <DiscordGlyph size={18} />
          {t('landing.signIn')}
        </a>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/"><SmallWordmark className={styles.mark} /></Link>
        {me && wanted !== null && wanted !== me.id ? (
          <Link className={styles.me} to="/conta" aria-label={`${me.nickname} #${me.id}`}>
            <AvatarFace avatar={me.avatar} seed={me.id} size={32} />
            <span className={styles.meNumber}>#{me.id}</span>
          </Link>
        ) : null}
      </header>
      <main className={styles.main}>{body}</main>
    </div>
  )
}

function OwnAccount({ me }: { me: Me }) {
  const t = useT()
  const navigate = useNavigate()
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] })
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [nextFriends, nextRequests, nextHistory] = await Promise.all([fetchFriends(), fetchFriendRequests(), fetchHistory(me.id)])
      setFriends(nextFriends)
      setRequests(nextRequests)
      setHistory(nextHistory ?? [])
    } catch {
      setFailed(true)
    }
  }, [me.id])

  useEffect(() => { void load() }, [load])

  const signOut = async () => {
    await logout().catch(() => undefined)
    navigate('/')
  }

  return (
    <div className={styles.layout}>
      <IdentityCard account={me} stats={me.stats} own>
        <Pill tone="soft" size="md" icon={<LogOut size={15} />} onClick={() => { void signOut() }}>{t('account.logout')}</Pill>
      </IdentityCard>
      <div className={styles.column}>
        {failed ? (
          <section className={styles.panel}>
            <Empty title={t('account.loadFailed')} action={<Pill tone="soft" size="md" onClick={() => { void load() }}>{t('account.retry')}</Pill>} />
          </section>
        ) : (
          <>
            <FriendsPanel friends={friends} requests={requests} reload={load} />
            <HistoryPanel history={history} loading={history === null} visibility={me.visibility} own />
          </>
        )}
      </div>
    </div>
  )
}

function OtherAccount({ id }: { id: number }) {
  const t = useT()
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [history, setHistory] = useState<HistoryEntry[] | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [nextProfile, nextHistory] = await Promise.all([fetchProfile(id), fetchHistory(id)])
      setProfile(nextProfile)
      setHistory(nextHistory)
    } catch {
      setFailed(true)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  if (failed) return <Empty title={t('account.loadFailed')} action={<Pill tone="soft" size="md" onClick={() => { void load() }}>{t('account.retry')}</Pill>} />
  if (profile === undefined) return <AccountSkeleton />
  if (profile === null) return <Empty icon={<X size={28} />} title={t('account.notFound')} />
  return (
    <div className={styles.layout}>
      <IdentityCard account={profile} stats={profile.stats} />
      <div className={styles.column}>
        <HistoryPanel history={history ?? null} />
      </div>
    </div>
  )
}

/** The big card on the left: the creature, the number, the nickname and the counts. */
function IdentityCard({ account, stats, own = false, children }: {
  account: AccountCard
  stats?: AccountStats
  own?: boolean
  children?: ReactNode
}) {
  const t = useT()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.nickname)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const nickname = draft.trim()
    if (!nickname || nickname === account.nickname) {
      setRenaming(false)
      return
    }
    try {
      await updateMe({ nickname })
      setRenaming(false)
      setError('')
    } catch {
      setError(t('account.saveFailed'))
    }
  }

  return (
    <aside className={styles.card}>
      <AvatarFace avatar={account.avatar} seed={account.id} size={200} className={styles.bigFace} />
      <div className={styles.names}>
        <span className={styles.number}>#{account.id}</span>
        {renaming ? (
          <form className={styles.rename} onSubmit={(event) => { void rename(event) }}>
            <Field
              aria-label={t('account.nickname')}
              value={draft}
              maxLength={32}
              autoFocus
              error={error || undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false) }}
            />
          </form>
        ) : (
          <div className={styles.nameRow}>
            <h1 className={styles.nickname}>{account.nickname}</h1>
            {own ? (
              <IconPill
                size="sm"
                label={t('account.rename')}
                icon={<Pencil size={14} />}
                onClick={() => { setDraft(account.nickname); setError(''); setRenaming(true) }}
              />
            ) : null}
          </div>
        )}
      </div>
      {own ? (
        <span className={styles.discordChip}>
          <DiscordGlyph size={16} />
          Discord
        </span>
      ) : null}
      {stats ? (
        <dl className={styles.stats}>
          <div className={styles.stat}><dt>{t('account.sessions')}</dt><dd>{stats.sessions}</dd></div>
          <div className={styles.stat}><dt>{t('account.hours')}</dt><dd>{Math.round(stats.hours)}h</dd></div>
          <div className={styles.stat}><dt>{t('account.friendCount')}</dt><dd>{stats.friends}</dd></div>
        </dl>
      ) : null}
      {own ? (
        <div className={styles.cardActions}>
          <button type="button" className={styles.changeAvatar} onClick={() => setEditing(true)}>{t('account.changeAvatar')}</button>
          {children}
        </div>
      ) : null}
      {own ? <AvatarDialog open={editing} onOpenChange={setEditing} avatar={account.avatar} /> : null}
    </aside>
  )
}

function AvatarDialog({ open, onOpenChange, avatar }: { open: boolean; onOpenChange: (open: boolean) => void; avatar: string }) {
  const t = useT()
  const [draft, setDraft] = useState(avatar)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setDraft(avatar)
      setError('')
    }
  }, [open, avatar])

  const save = async () => {
    setBusy(true)
    try {
      await updateMe({ avatar: draft })
      onOpenChange(false)
    } catch {
      setError(t('account.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('account.avatarTitle')} closeLabel={t('account.close')} wide>
      <div className={styles.dialogBody}>
        <AvatarEditor value={draft} onChange={setDraft} />
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.dialogActions}>
          <Pill tone="brand" size="lg" disabled={busy || draft === avatar} onClick={() => { void save() }}>{t('account.save')}</Pill>
        </div>
      </div>
    </Modal>
  )
}

function Person({ person, index, dim = false, children }: { person: AccountCard; index: number; dim?: boolean; children?: ReactNode }) {
  return (
    <li className={styles.person} data-dim={dim || undefined} style={stagger(index)}>
      <Link className={styles.personLink} to={`/u/${person.id}`}>
        <AvatarFace avatar={person.avatar} seed={person.id} size={44} still={dim} />
        <span className={styles.personName}>
          {person.nickname} <span className={styles.personNumber}>#{person.id}</span>
        </span>
      </Link>
      {children}
    </li>
  )
}

function FriendsPanel({ friends, requests, reload }: { friends: Friend[] | null; requests: FriendRequests; reload: () => Promise<void> }) {
  const t = useT()
  const { toast } = useToast()
  const [number, setNumber] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const numberRef = useRef<HTMLInputElement>(null)

  const ask = async (event: FormEvent, close: () => void) => {
    event.preventDefault()
    const id = Number(number.replace(/^#/, '').trim())
    if (!Number.isInteger(id) || id < 1) {
      setError(t('account.userNotFound'))
      return
    }
    try {
      const state = await requestFriend(id)
      toast(t(state === 'friends' ? 'account.nowFriends' : 'account.requested'))
      setNumber('')
      setError('')
      close()
      await reload()
    } catch (failure) {
      setError(t(errorText[(failure as Error).message] ?? 'account.saveFailed'))
    }
  }

  const answer = async (action: () => Promise<void>) => {
    await action().catch(() => undefined)
    await reload()
  }

  const [inviting, setInviting] = useState<number | null>(null)

  const invite = async (friend: Friend) => {
    setInviting(friend.id)
    try {
      await inviteFriend(friend.id)
      toast(t('account.inviteSent'))
    } catch (failure) {
      const { message, roomId } = failure instanceof InviteError ? failure : new InviteError('failed')
      if (message === 'dm_closed' && roomId) {
        try { await navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`) } catch {}
        toast(t('account.inviteDmClosed').replace('{name}', friend.nickname))
      } else {
        toast(t(inviteErrorText[message] ?? 'account.inviteFailed'))
      }
    } finally {
      setInviting(null)
    }
  }

  // Who is in a room first, then everyone else.
  const sorted = [...(friends ?? [])].sort((a, b) => Number(b.presence.inRoom) - Number(a.presence.inRoom))
  const pending = requests.incoming.length + requests.outgoing.length

  return (
    <section className={styles.panel} aria-labelledby="friends-title" aria-busy={friends === null || undefined}>
      <div className={styles.panelHead}>
        <h2 id="friends-title" className={styles.panelTitle}>{t('account.friends')}</h2>
        <SpringPopover
          trigger={<><Plus size={15} aria-hidden="true" />{t('account.add')}</>}
          triggerClassName={styles.addTrigger}
          align="end"
          width="18rem"
          initialFocus={numberRef}
          open={adding}
          onOpenChange={(open) => { setAdding(open); if (!open) setError('') }}
        >
          {({ close }) => (
            <form className={styles.addForm} onSubmit={(event) => { void ask(event, close) }}>
              <Field
                ref={numberRef}
                mono
                inputMode="numeric"
                aria-label={t('account.number')}
                placeholder="#128"
                value={number}
                error={error || undefined}
                onChange={(event) => { setNumber(event.target.value); setError('') }}
              />
              <Pill type="submit" tone="brand" size="md" block disabled={!number.trim()}>{t('account.send')}</Pill>
            </form>
          )}
        </SpringPopover>
      </div>

      {pending ? (
        <ul className={styles.people}>
          {requests.incoming.map((person, index) => (
            <Person key={`in-${person.id}`} person={person} index={index}>
              <div className={styles.personActions}>
                <IconPill size="sm" label={`${t('account.accept')} ${person.nickname}`} icon={<Check size={15} />} active onClick={() => { void answer(() => acceptFriend(person.id)) }} />
                <IconPill size="sm" label={`${t('account.decline')} ${person.nickname}`} icon={<X size={15} />} onClick={() => { void answer(() => dropFriendRequest(person.id)) }} />
              </div>
            </Person>
          ))}
          {requests.outgoing.map((person, index) => (
            <Person key={`out-${person.id}`} person={person} index={requests.incoming.length + index} dim>
              <div className={styles.personActions}>
                <Tip label={t('account.waiting')}><Clock size={15} className={styles.quiet} aria-hidden="true" /></Tip>
                <IconPill size="sm" label={`${t('account.withdraw')} ${person.nickname}`} icon={<X size={15} />} onClick={() => { void answer(() => dropFriendRequest(person.id)) }} />
              </div>
            </Person>
          ))}
        </ul>
      ) : null}

      {friends === null ? (
        <ul className={styles.people}>
          {[0, 1, 2, 3].map((index) => <PersonSkeleton key={index} index={index} />)}
        </ul>
      ) : sorted.length === 0 && !pending ? (
        <Empty title={t('account.friendsEmpty')} />
      ) : (
        <ul className={styles.people}>
          {sorted.map((friend, index) => (
            <Person key={friend.id} person={friend} index={pending + index} dim={!friend.presence.inRoom}>
              <div className={styles.personActions}>
                {friend.presence.roomId ? (
                  <Tip
                    label={t('account.joinRoom')}
                    render={<Link className={styles.roomCode} to={`/room/${friend.presence.roomId}`}>{friend.presence.roomId}</Link>}
                  />
                ) : friend.presence.inRoom ? (
                  <Tip label={t('account.closedRoom')}><Lock size={15} className={styles.quiet} aria-hidden="true" /></Tip>
                ) : null}
                {friend.presence.withMe ? null : (
                  <IconPill
                    size="sm"
                    label={t('account.invite').replace('{name}', friend.nickname)}
                    icon={friend.presence.inRoom ? <Send size={14} /> : <Plus size={15} />}
                    loading={inviting === friend.id}
                    disabled={inviting !== null}
                    onClick={() => { void invite(friend) }}
                  />
                )}
              </div>
            </Person>
          ))}
        </ul>
      )}
    </section>
  )
}

const KIND_ICON: Record<string, ReactNode> = {
  screen: <Monitor size={22} />,
  live: <Radio size={22} />,
}

function HistoryPanel({ history, loading = false, visibility, own = false }: {
  history: HistoryEntry[] | null
  loading?: boolean
  visibility?: Visibility
  own?: boolean
}) {
  const t = useT()
  const [shown, setShown] = useState<Visibility>(visibility ?? 'friends')

  const choose = (next: Visibility) => {
    const before = shown
    setShown(next)
    updateMe({ visibility: next }).catch(() => setShown(before))
  }

  return (
    <section className={styles.panel} aria-labelledby="history-title" aria-busy={loading || undefined}>
      <div className={styles.panelHead}>
        <h2 id="history-title" className={styles.panelTitle}>{t('account.history')}</h2>
        {own ? (
          <Segmented
            label={t('account.visibility')}
            value={shown}
            onChange={choose}
            options={[
              { value: 'public', label: t('account.public') },
              { value: 'friends', label: t('account.friendsOnly') },
              { value: 'private', label: t('account.private') },
            ]}
          />
        ) : null}
      </div>
      {loading ? (
        <ul className={styles.history}>
          {[0, 1, 2, 3].map((index) => <EntrySkeleton key={index} index={index} />)}
        </ul>
      ) : history === null ? (
        own ? null : <Empty icon={<Lock size={24} />} title={t('account.historyHidden')} />
      ) : history.length === 0 ? (
        <Empty title={t('account.historyEmpty')} />
      ) : (
        <ul className={styles.history}>
          {history.map((entry, index) => (
            <li key={`${entry.startedAt}-${index}`} className={styles.entry} style={stagger(index)}>
              <div className={styles.cover} data-hue={hueOf(entry.title)} aria-hidden="true">
                {KIND_ICON[entry.kind] ?? <Film size={22} />}
              </div>
              <span className={styles.entryTitle}>{entry.title}</span>
              <div className={styles.entryFoot}>
                <span className={styles.when}>{whenLabel(entry.startedAt, t)}</span>
                <span className={styles.with}>
                  {entry.with.slice(0, 4).map((person) => (
                    <Tip key={person.id} label={person.nickname}>
                      <AvatarFace avatar={person.avatar} seed={person.id} size={24} still />
                    </Tip>
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The page's shape before the account arrives: the card, and the panels when they will follow. */
function AccountSkeleton({ panels = false }: { panels?: boolean }) {
  return (
    <div className={styles.layout} aria-busy="true">
      <aside className={styles.card}>
        <Skeleton round className={styles.bigFace} style={{ aspectRatio: '1' }} />
        <div className={styles.names}>
          <Skeleton width="6rem" height="3.5rem" />
          <Skeleton width="9rem" height="1.75rem" />
        </div>
        <div className={styles.stats}>
          {[0, 1, 2].map((index) => <Skeleton key={index} height="5.25rem" className={styles.statSkeleton} />)}
        </div>
      </aside>
      {panels ? (
        <div className={styles.column}>
          <section className={styles.panel}>
            <Skeleton width="7rem" height="1.75rem" />
            <ul className={styles.people}>
              {[0, 1, 2, 3].map((index) => <PersonSkeleton key={index} index={index} />)}
            </ul>
          </section>
          <section className={styles.panel}>
            <Skeleton width="7rem" height="1.75rem" />
            <ul className={styles.history}>
              {[0, 1, 2, 3].map((index) => <EntrySkeleton key={index} index={index} />)}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function PersonSkeleton({ index }: { index: number }) {
  return (
    <li className={styles.person} style={stagger(index)} aria-hidden="true">
      <Skeleton round width={44} height={44} />
      <Skeleton width="55%" height="1rem" />
    </li>
  )
}

function EntrySkeleton({ index }: { index: number }) {
  return (
    <li className={styles.entry} style={stagger(index)} aria-hidden="true">
      <Skeleton className={styles.coverSkeleton} />
      <Skeleton width="80%" height="0.875rem" />
      <Skeleton width="40%" height="0.75rem" />
    </li>
  )
}

function Empty({ icon, title, action }: { icon?: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      {icon ? <span className={styles.emptyIcon} aria-hidden="true">{icon}</span> : null}
      <p className={styles.emptyTitle}>{title}</p>
      {action}
    </div>
  )
}
