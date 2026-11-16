import { MessageCircle } from 'lucide-react'
import { useT } from '../i18n/useT'
import { arrive } from '../ui/arrive'
import { closeChat, openChat, useChatUi } from './chatUi'
import { unreadTotal, useInbox } from './inbox'
import styles from '../account/NotificationBell.module.css'

/** The header's way to the messages, with how many wait unread. */
export function MessagesButton() {
  const t = useT()
  const inbox = useInbox()
  const ui = useChatUi()
  if (inbox.me === null) return null
  const count = unreadTotal(inbox)
  const label = count > 0 ? `${t('social.messages')} (${count})` : t('social.messages')
  return (
    <button
      type="button"
      className={`${styles.bell} ${arrive}`}
      aria-label={label}
      title={label}
      aria-expanded={ui.open}
      onClick={() => (ui.open ? closeChat() : openChat())}
    >
      <MessageCircle size={18} aria-hidden="true" />
      {count > 0 ? <span className={styles.count} aria-hidden="true">{count > 9 ? '9+' : count}</span> : null}
    </button>
  )
}
