import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react'
import { SendHorizontal, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ChatEntry } from '../types'
import { Button } from '../ui/Button'
import type { Translator } from '../i18n/useT'

const mobileMediaQuery = '(max-width: 900px)'
/** How far above the bottom a reader can be and still count as following the conversation. */
const FOLLOW_SLACK_PX = 48

interface ChatProps {
  messages: ChatEntry[]
  open: boolean
  onClose: () => void
  onSend: (text: string) => void
  t: Translator
}

export const Chat = memo(function Chat({ messages, open, onClose, onSend, t }: ChatProps) {
  const [text, setText] = useState('')
  const [mobile, setMobile] = useState(() => matchMedia(mobileMediaQuery).matches)
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const listRef = useRef<HTMLDivElement>(null)
  // Whether the reader is at the bottom: a new message keeps them there, and
  // a reader who scrolled up to reread something is left where they are.
  const followingRef = useRef(true)

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget
    followingRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX
  }

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !open || !followingRef.current) return
    list.scrollTop = list.scrollHeight
  }, [messages, open])

  useEffect(() => {
    const mobileQuery = matchMedia(mobileMediaQuery)
    const motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
    const updateMobile = () => setMobile(mobileQuery.matches)
    const updateMotion = () => setReducedMotion(motionQuery.matches)
    mobileQuery.addEventListener('change', updateMobile)
    motionQuery.addEventListener('change', updateMotion)
    return () => {
      mobileQuery.removeEventListener('change', updateMobile)
      motionQuery.removeEventListener('change', updateMotion)
    }
  }, [])

  const submit = () => {
    const value = text.trim()
    if (!value) return
    followingRef.current = true
    onSend(value)
    setText('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <aside className={`chat-panel ${mobile ? 'chat-drawer' : 'chat-docked'} ${open ? 'is-open' : ''} ${reducedMotion ? 'reduced-motion' : ''}`}>
      <header>
        <h2>{t('chat.title')}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('chat.close')}>
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 ? <p className="empty-copy">{t('chat.empty')}</p> : messages.map((message, index) => (
          <article className={`chat-message ${message.system ? 'is-system' : ''}`} key={`${message.at}-${index}`} style={{ '--i': index } as CSSProperties}>
            {message.system
              ? <p>{message.author} {message.text}</p>
              : <><strong>{message.author}</strong><p>{message.text}</p></>}
          </article>
        ))}
      </div>
      <div className="chat-composer">
        <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} placeholder={t('chat.placeholder')} maxLength={2048} />
        <Button variant="ghost" size="icon" onClick={submit} aria-label={t('chat.send')}>
          <SendHorizontal size={16} aria-hidden="true" />
        </Button>
      </div>
    </aside>
  )
})
