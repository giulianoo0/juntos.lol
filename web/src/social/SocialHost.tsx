import { useEffect, useRef } from 'react'
import { useMe } from '../account'
import { useT } from '../i18n/useT'
import { useToast } from '../ui/toastContext'
import { useChatUi } from './chatUi'
import { nameOf } from './friends'
import { useInboxFor, useInbox } from './inbox'
import { Messages } from './Messages'

/** Keeps the inbox open for whoever is signed in, the panel mounted, and a toast for a message that lands while it is shut. */
export function SocialHost() {
  const { me } = useMe()
  useInboxFor(me?.id ?? null)
  const inbox = useInbox()
  const ui = useChatUi()
  const t = useT()
  const { toast } = useToast()
  const seen = useRef<Map<number, number>>(new Map())
  const primed = useRef(false)

  useEffect(() => {
    if (inbox.status !== 'live') return
    const first = !primed.current
    primed.current = true
    for (const thread of Object.values(inbox.threads)) {
      const last = thread.messages[thread.messages.length - 1]
      if (!last || last.id === 0) continue
      const before = seen.current.get(thread.friendId) ?? 0
      seen.current.set(thread.friendId, Math.max(before, last.id))
      if (first || last.id <= before || last.from !== thread.friendId || thread.unread === 0) continue
      if (ui.open && ui.friendId === thread.friendId) continue
      const text = last.text ?? t('social.unavailable')
      toast(t('social.newMessage').replace('{name}', nameOf(thread.friendId)).replace('{text}', text.length > 80 ? `${text.slice(0, 80)}…` : text))
    }
  }, [inbox, ui.open, ui.friendId, t, toast])

  return me ? <Messages /> : null
}
