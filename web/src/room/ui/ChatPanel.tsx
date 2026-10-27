import { ArrowUp } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type UIEvent } from 'react'
import { hueOf } from '../../ui/hue'
import { useSendFlight } from '../../ui/useSendFlight'
import { clockOf, groupChat } from './chatGroups'
import { Face } from './Face'
import { useRoomUi } from './context'
import styles from './ChatPanel.module.css'

/** How far above the end a reader can be and still follow the chat. */
const FOLLOW_SLACK_PX = 48

/** Only emoji, a few of them: said big, without a bubble. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u

/**
 * The chat as bubbles: others on the left under their creature, a run of
 * theirs stacked in one column; yours on the right in the brand colour,
 * rising out of the composer (the lawcore's flight). An empty chat shows
 * the room's creatures waiting for someone to start.
 */
export function ChatPanel() {
  const { vm, strings } = useRoomUi()
  const avatarOf = (id: string) => vm.people.find((person) => person.id === id)?.avatar
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const following = useRef(true)
  const lines = useMemo(() => groupChat(vm.chat), [vm.chat])
  const lastOwnId = useMemo(() => {
    for (let index = vm.chat.length - 1; index >= 0; index -= 1) {
      const message = vm.chat[index]
      if (message && message.authorId === vm.selfId && !message.system) return message.id
    }
    return null
  }, [vm.chat, vm.selfId])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && following.current) list.scrollTop = list.scrollHeight
  }, [lines])

  // Runs after the scroll above, so the flight measures the line in place.
  const { launch } = useSendFlight(listRef, lastOwnId)

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget
    following.current = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    const pill = composerRef.current?.getBoundingClientRect()
    if (pill) launch({ right: pill.right, bottom: pill.bottom, width: pill.width })
    following.current = true
    vm.actions.sendChat(value)
    setText('')
  }

  return (
    <div className={styles.chat}>
      <div className={styles.list} ref={listRef} onScroll={onScroll}>
        <div className={styles.lines}>
          {lines.length === 0 ? (
            <div className={styles.empty}>
              <span className={styles.crowd} aria-hidden="true">
                {vm.people.slice(0, 4).map((person, index) => (
                  <span key={person.id} className={styles.peek} style={{ '--peek': index } as CSSProperties}>
                    <Face id={person.id} avatar={person.avatar} size={52} still={false} />
                  </span>
                ))}
              </span>
              <p className={styles.emptyTitle}>{strings.chatEmpty}</p>
            </div>
          ) : null}
          {lines.map((line) => {
            if (line.system) {
              return (
                <p key={line.id} className={styles.system} data-message-id={line.id}>
                  <Face id={line.authorId} avatar={avatarOf(line.authorId)} size={18} />
                  <span>{line.author} {line.text}</span>
                </p>
              )
            }
            const own = line.authorId === vm.selfId
            const big = EMOJI_ONLY.test(line.text.trim())
            return (
              <div key={line.id} className={styles.message} data-head={line.head || undefined} data-own={own || undefined} data-message-id={line.id}>
                {own ? null : (
                  <span className={styles.gutter}>{line.head ? <Face id={line.authorId} avatar={avatarOf(line.authorId)} size={34} /> : null}</span>
                )}
                <div className={styles.body}>
                  {line.head && !own ? (
                    <span className={styles.meta}>
                      <span className={styles.author} style={{ '--author-ink': `var(--hue-${hueOf(line.authorId)}-ink)` } as CSSProperties}>{line.author}</span>
                      <time className={styles.time} dateTime={new Date(line.at).toISOString()}>{clockOf(line.at)}</time>
                    </span>
                  ) : null}
                  <span className={styles.bubble} data-big={big || undefined} data-flight title={own ? clockOf(line.at) : undefined}>{line.text}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <form ref={composerRef} className={styles.composer} onSubmit={submit}>
        <input
          className={styles.input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={strings.message}
          placeholder={strings.message}
          autoComplete="off"
          maxLength={2048}
        />
        <button type="submit" className={styles.send} aria-label={strings.send} title={strings.send} disabled={!text.trim()}>
          <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}
