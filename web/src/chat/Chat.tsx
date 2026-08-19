import { useEffect, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type { ChatEntry } from '../types'
import { Button } from '../ui/Button'
import type { Translator } from '../i18n/useT'

const mobileMediaQuery = '(max-width: 900px)'

interface ChatProps {
  messages: ChatEntry[]
  open: boolean
  onClose: () => void
  onSend: (text: string) => void
  t: Translator
}

export function Chat({ messages, open, onClose, onSend, t }: ChatProps) {
  const [text, setText] = useState('')
  const [mobile, setMobile] = useState(() => matchMedia(mobileMediaQuery).matches)
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)

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
      <div className="chat-messages">
        {messages.length === 0 ? <p className="empty-copy">{t('chat.empty')}</p> : messages.map((message, index) => (
          <article className={`chat-message ${message.system ? 'is-system' : ''}`} key={`${message.at}-${index}`} style={{ animationDelay: `${Math.min(index * 35, 300)}ms` }}>
            {message.system
              ? <p>{message.author} {message.text}</p>
              : <><strong>{message.author}</strong><p>{message.text}</p></>}
          </article>
        ))}
      </div>
      <div className="chat-composer sunken">
        <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} placeholder={t('chat.placeholder')} maxLength={2048} />
        <Button variant="ghost" onClick={submit}>{t('chat.send')}</Button>
      </div>
    </aside>
  )
}
