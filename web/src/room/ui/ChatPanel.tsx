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

/**
 * The chat as Discord lays it out: avatar, the name in the person's hue
 * and the hour on the first line of a run, the rest under it. What you
 * send rises out of the composer (the lawcore's flight); what others
 * send is simply there.
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
          {lines.map((line) => line.system ? (
            <p key={line.id} className={styles.system} data-message-id={line.id}>{line.author} {line.text}</p>
          ) : (
            <div key={line.id} className={styles.message} data-head={line.head || undefined} data-message-id={line.id}>
              <span className={styles.gutter}>{line.head ? <Face id={line.authorId} avatar={avatarOf(line.authorId)} size={32} /> : null}</span>
              <div className={styles.body} data-flight>
                {line.head ? (
                  <span className={styles.meta}>
                    <span className={styles.author} style={{ '--author-ink': `var(--hue-${hueOf(line.authorId)}-ink)` } as CSSProperties}>{line.author}</span>
                    <time className={styles.time} dateTime={new Date(line.at).toISOString()}>{clockOf(line.at)}</time>
                  </span>
                ) : null}
                <span className={styles.text}>{line.text}</span>
              </div>
            </div>
          ))}
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
