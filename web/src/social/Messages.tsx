import { AlertCircle, ArrowLeft, ArrowUp, KeyRound, Lock, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { profilePath, useMe, type Friend } from '../account'
import { useT, type Translator } from '../i18n/useT'
import { Tip } from '../ui/Tip'
import { closeChat, openChat, showList, useChatUi } from './chatUi'
import { FriendFace } from './FriendFace'
import { KeyDialog } from './KeyDialog'
import { useFriends, whereabouts } from './friends'
import { loadThread, newClientId, retryMessage, sendMessage, showThread, typing, useInbox, type ChatMessage, type Thread } from './inbox'
import styles from './Messages.module.css'

const GROUP_MS = 5 * 60_000

/** The messages panel: the conversations, and one conversation. It floats at the side and stays while one keeps browsing. */
export function Messages() {
  const t = useT()
  const { me } = useMe()
  const ui = useChatUi()
  const inbox = useInbox()
  const { friends } = useFriends(Boolean(me))
  const panelRef = useRef<HTMLElement>(null)
  const friend = ui.friendId !== null ? friends?.find((each) => each.id === ui.friendId) ?? null : null

  useEffect(() => {
    showThread(ui.open && ui.friendId !== null ? ui.friendId : null)
    return () => showThread(null)
  }, [ui.open, ui.friendId])

  useEffect(() => {
    if (!ui.open) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (ui.friendId !== null) showList()
      else closeChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui.open, ui.friendId])

  if (!me) return null
  return (
    <aside
      ref={panelRef}
      className={styles.panel}
      data-open={ui.open || undefined}
      aria-hidden={!ui.open || undefined}
      inert={!ui.open || undefined}
      aria-label={t('social.messages')}
    >
      {friend ? (
        <Conversation key={friend.id} friend={friend} thread={inbox.threads[friend.id]} me={me.id} live={inbox.status === 'live'} t={t} />
      ) : (
        <ThreadList friends={friends} threads={inbox.threads} status={inbox.status} t={t} />
      )}
    </aside>
  )
}

function lastOf(thread: Thread | undefined): ChatMessage | undefined {
  return thread?.messages[thread.messages.length - 1]
}

function ThreadList({ friends, threads, status, t }: {
  friends: Friend[] | null
  threads: Record<number, Thread>
  status: string
  t: Translator
}) {
  const [keyOpen, setKeyOpen] = useState(false)
  const ordered = useMemo(() => {
    if (!friends) return []
    return [...friends].sort((a, b) => {
      const la = lastOf(threads[a.id])
      const lb = lastOf(threads[b.id])
      if (la && lb) return Date.parse(lb.at) - Date.parse(la.at)
      if (la) return -1
      if (lb) return 1
      return 0
    })
  }, [friends, threads])

  return (
    <>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('social.messages')}</h2>
        {status === 'connecting' ? <Tip label={t('social.offline')}><span className={styles.reconnecting} /></Tip> : null}
        {status === 'live' ? (
          <Tip label={t('social.key')} render={<button type="button" className={styles.iconButton} aria-label={t('social.key')} onClick={() => setKeyOpen(true)} />}>
            <KeyRound size={17} />
          </Tip>
        ) : null}
        <button type="button" className={styles.iconButton} aria-label={t('social.close')} onClick={closeChat}><X size={18} /></button>
      </header>
      <KeyDialog open={keyOpen} onOpenChange={setKeyOpen} />
      {status === 'unsupported' ? <p className={styles.empty}>{t('social.unsupported')}</p> : null}
      {friends && friends.length === 0 ? <p className={styles.empty}>{t('social.noFriends')}</p> : null}
      <ul className={styles.threads}>
        {ordered.map((friend, index) => {
          const thread = threads[friend.id]
          const last = lastOf(thread)
          return (
            <li key={friend.id} style={{ '--i': index } as React.CSSProperties}>
              <button type="button" className={styles.threadRow} onClick={() => openChat(friend.id)}>
                <FriendFace friend={friend} size={40} />
                <span className={styles.threadText}>
                  <span className={styles.threadName}>{friend.nickname}</span>
                  {last ? <span className={styles.preview} data-unread={thread?.unread ? '' : undefined}>{last.text ?? t('social.unavailable')}</span> : null}
                </span>
                {last ? <time className={styles.threadTime} dateTime={last.at}>{shortTime(last.at, t)}</time> : null}
                {thread?.unread ? <span className={styles.unread}>{thread.unread > 9 ? '9+' : thread.unread}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function shortTime(iso: string, t: Translator): string {
  const at = new Date(iso)
  const now = new Date()
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(t.language, { hour: '2-digit', minute: '2-digit' })
  return at.toLocaleDateString(t.language, { day: 'numeric', month: 'short' })
}

function dayLabel(iso: string, t: Translator): string {
  const at = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (at.toDateString() === today.toDateString()) return t('social.today')
  if (at.toDateString() === yesterday.toDateString()) return t('social.yesterday')
  return at.toLocaleDateString(t.language, { weekday: 'long', day: 'numeric', month: 'long' })
}

function statusLabel(friend: Friend, t: Translator): string {
  switch (whereabouts(friend)) {
    case 'room': return friend.presence.roomName ? t('social.inRoomNamed').replace('{room}', friend.presence.roomName) : t('social.inRoom')
    case 'juntos': return t('social.onJuntos')
    case 'discord': return friend.presence.discord === 'idle' ? t('social.idle') : friend.presence.discord === 'dnd' ? t('social.dnd') : t('social.onDiscord')
    default: return t('social.away')
  }
}

function Conversation({ friend, thread, me, live, t }: { friend: Friend; thread: Thread | undefined; me: number; live: boolean; t: Translator }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const keepFrom = useRef<number | null>(null)
  const launch = useRef<{ clientId: string; from: DOMRect } | null>(null)
  const [draft, setDraft] = useState('')
  const [now, setNow] = useState(Date.now())
  const messages = thread?.messages ?? []
  const typingNow = (thread?.typingUntil ?? 0) > now

  useEffect(() => {
    if (!thread?.loaded) void loadThread(friend.id)
  }, [friend.id, thread?.loaded, live])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [friend.id])

  useEffect(() => {
    if (!typingNow) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(50, (thread?.typingUntil ?? 0) - Date.now()))
    return () => clearTimeout(timer)
  }, [typingNow, thread?.typingUntil])
  useEffect(() => { setNow(Date.now()) }, [thread?.typingUntil])

  // New messages keep the view at the bottom when it was there; an older page keeps the reader's place.
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    if (keepFrom.current !== null) {
      box.scrollTop = box.scrollHeight - keepFrom.current
      keepFrom.current = null
      return
    }
    if (stick.current) box.scrollTop = box.scrollHeight
    flyFromComposer(box, launch.current)
    launch.current = null
  }, [messages.length, typingNow])

  useEffect(() => {
    const top = topRef.current
    const box = scrollRef.current
    if (!top || !box || !thread?.more) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !thread.loading) {
        keepFrom.current = box.scrollHeight - box.scrollTop
        void loadThread(friend.id, true)
      }
    }, { root: box, rootMargin: '120px 0px 0px 0px' })
    observer.observe(top)
    return () => observer.disconnect()
  }, [friend.id, thread?.more, thread?.loading])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    stick.current = true
    setDraft('')
    const clientId = newClientId()
    const input = inputRef.current
    if (input) launch.current = { clientId, from: input.getBoundingClientRect() }
    void sendMessage(friend.id, text, clientId)
    inputRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const lastMine = [...messages].reverse().find((m) => m.from === me)
  const seen = Boolean(lastMine && lastMine.id > 0 && (thread?.theyRead ?? 0) >= lastMine.id)

  return (
    <>
      <header className={styles.head}>
        <button type="button" className={styles.iconButton} aria-label={t('social.back')} onClick={showList}><ArrowLeft size={18} /></button>
        <Link to={profilePath(friend.id)} className={styles.person} onClick={closeChat}>
          <FriendFace friend={friend} size={32} />
          <span className={styles.personName}>{friend.nickname}</span>
        </Link>
        <Tip label={statusLabel(friend, t)}><span className={styles.statusDot} data-where={whereabouts(friend)} /></Tip>
        <Tip label={t('social.encrypted')}><span className={styles.lock}><Lock size={14} /></span></Tip>
        <button type="button" className={styles.iconButton} aria-label={t('social.close')} onClick={closeChat}><X size={18} /></button>
      </header>
      <div
        ref={scrollRef}
        className={styles.scroll}
        onScroll={(event) => {
          const box = event.currentTarget
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80
        }}
      >
        <div ref={topRef} className={styles.top} />
        {thread?.loaded && messages.length === 0 ? <p className={styles.say}>{t('social.noMessages')}</p> : null}
        <ol className={styles.messages}>
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const next = messages[index + 1]
            const newDay = !previous || new Date(previous.at).toDateString() !== new Date(message.at).toDateString()
            const mine = message.from === me
            const joinsPrevious = !newDay && previous?.from === message.from && Date.parse(message.at) - Date.parse(previous.at) < GROUP_MS
            const joinsNext = next && next.from === message.from && Date.parse(next.at) - Date.parse(message.at) < GROUP_MS &&
              new Date(next.at).toDateString() === new Date(message.at).toDateString()
            return (
              <li key={message.clientId || message.id} className={styles.item}>
                {newDay ? <div className={styles.day}><span>{dayLabel(message.at, t)}</span></div> : null}
                <div className={styles.row} data-mine={mine || undefined} data-joined={joinsPrevious || undefined}>
                  <div
                    className={styles.bubble}
                    data-client={message.clientId || undefined}
                    data-mine={mine || undefined}
                    data-state={message.state}
                    data-gone={message.text === null || undefined}
                    data-tail={!joinsNext || undefined}
                  >
                    {message.text ?? t('social.unavailable')}
                  </div>
                  {!joinsNext ? (
                    <span className={styles.meta}>
                      <time dateTime={message.at}>{new Date(message.at).toLocaleTimeString(t.language, { hour: '2-digit', minute: '2-digit' })}</time>
                      {mine ? <Receipt message={message} seen={seen && message === lastMine} friendId={friend.id} t={t} /> : null}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
          {typingNow ? (
            <li className={styles.item} aria-label={t('social.typing').replace('{name}', friend.nickname)}>
              <div className={styles.row}>
                <div className={styles.bubble} data-typing=""><span /><span /><span /></div>
              </div>
            </li>
          ) : null}
        </ol>
      </div>
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={1}
          value={draft}
          maxLength={4000}
          aria-label={t('social.write')}
          placeholder={t('social.write')}
          onChange={(event) => { setDraft(event.target.value); typing(friend.id) }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className={styles.send} aria-label={t('social.send')} disabled={!draft.trim()}><ArrowUp size={18} /></button>
      </form>
    </>
  )
}

/**
 * The sent bubble leaves the composer: it starts where the text was typed,
 * in the field's shape, and springs into its place in the thread.
 */
function flyFromComposer(box: HTMLElement, launch: { clientId: string; from: DOMRect } | null) {
  if (!launch || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const bubble = box.querySelector<HTMLElement>(`[data-client="${CSS.escape(launch.clientId)}"]`)
  if (!bubble || typeof bubble.animate !== 'function') return
  const row = bubble.parentElement ?? bubble
  const to = bubble.getBoundingClientRect()
  const dx = launch.from.left + 12 - to.left
  const dy = launch.from.top + (launch.from.height - to.height) / 2 - to.top
  const root = getComputedStyle(document.documentElement)
  bubble.style.animation = 'none'
  const spring = root.getPropertyValue('--ease-spring-pop').trim() || 'cubic-bezier(0.34, 1.4, 0.64, 1)'
  row.style.transformOrigin = `${to.left - row.getBoundingClientRect().left}px ${to.bottom - row.getBoundingClientRect().top}px`
  row.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(0.92)`, opacity: 0.4, filter: 'blur(2px)' },
    { transform: 'none', opacity: 1, filter: 'none' },
  ], { duration: 640, easing: spring })
}

/** The ticks: one drawn when the server has it, a second drawn beside it, in the brand's color, once it is seen. */
function Receipt({ message, seen, friendId, t }: { message: ChatMessage; seen: boolean; friendId: number; t: Translator }) {
  if (message.state === 'failed') {
    return (
      <Tip
        label={t('social.retry')}
        render={<button type="button" className={styles.retry} aria-label={t('social.retry')} onClick={() => retryMessage(friendId, message.clientId)} />}
      >
        <AlertCircle size={14} />
      </Tip>
    )
  }
  const stage = message.state === 'sending' ? 'sending' : seen ? 'seen' : 'sent'
  const label = t(stage === 'sending' ? 'social.sending' : stage === 'seen' ? 'social.seen' : 'social.delivered')
  return (
    <Tip label={label}>
      <span className={styles.receipt} data-stage={stage} role="img" aria-label={label}>
        <svg viewBox="0 0 20 14" width="18" height="13" aria-hidden="true">
          <path className={styles.tickOne} pathLength={1} d="M1.5 7.5 L5.5 11.5 L13 3" />
          <path className={styles.tickTwo} pathLength={1} d="M8.5 10.5 L9.5 11.5 L17 3" />
        </svg>
      </span>
    </Tip>
  )
}
