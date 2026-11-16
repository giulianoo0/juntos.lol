import { DoorOpen, MessageCircle, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { profilePath, type Friend } from '../account'
import { useT, type Translator } from '../i18n/useT'
import { SpringPopover, SpringRow } from '../ui/SpringPopover'
import { openChat } from './chatUi'
import { FriendFace } from './FriendFace'
import { useFriends, whereabouts } from './friends'
import { useInbox } from './inbox'
import styles from './FriendsFeed.module.css'

export function presenceLabel(friend: Friend, t: Translator): string {
  switch (whereabouts(friend)) {
    case 'room': return friend.presence.roomName ? t('social.inRoomNamed').replace('{room}', friend.presence.roomName) : t('social.inRoom')
    case 'juntos': return t('social.onJuntos')
    case 'discord': return friend.presence.discord === 'idle' ? t('social.idle') : friend.presence.discord === 'dnd' ? t('social.dnd') : t('social.onDiscord')
    default: return t('social.away')
  }
}

/**
 * Who is around now: friends in a room, with juntos open or on Discord, each
 * a creature with their Discord picture under it. A tap opens what can be
 * done with them: talk, walk into their room, see the profile.
 */
export function FriendsFeed() {
  const t = useT()
  const navigate = useNavigate()
  const inbox = useInbox()
  const { friends } = useFriends(true)
  if (!friends || friends.length === 0) return null
  const around = friends.filter((friend) => whereabouts(friend) !== 'away')
  if (around.length === 0) return null

  return (
    <section className={styles.feed} aria-label={t('social.online')}>
      <h2 className={styles.title}>{t('social.online')}</h2>
      <ul className={styles.list}>
          {around.map((friend, index) => {
            const unread = inbox.threads[friend.id]?.unread ?? 0
            const label = presenceLabel(friend, t)
            return (
              <li key={friend.id} className={styles.item} style={{ '--i': index } as React.CSSProperties}>
                <SpringPopover
                  triggerRender={<button type="button" className={styles.person} data-where={whereabouts(friend)} />}
                  trigger={(
                    <>
                      <FriendFace friend={friend} size={52} />
                      <span className={styles.name}>{friend.nickname}</span>
                      {unread > 0 ? <span className={styles.unread} aria-hidden="true">{unread > 9 ? '9+' : unread}</span> : null}
                    </>
                  )}
                  triggerLabel={`${friend.nickname}, ${label}`}
                  title={label}
                  align="center"
                  width="15rem"
                >
                  {({ close }) => (
                    <div role="menu" aria-label={friend.nickname}>
                      <SpringRow icon={<MessageCircle size={16} />} label={t('social.message')} onSelect={() => { close(); openChat(friend.id) }} />
                      {friend.presence.roomId ? (
                        <SpringRow icon={<DoorOpen size={16} />} label={t('social.joinRoom')} onSelect={() => { close(); navigate(`/room/${friend.presence.roomId}`) }} />
                      ) : null}
                      <SpringRow icon={<UserRound size={16} />} label={t('account.viewProfile')} onSelect={() => { close(); navigate(profilePath(friend.id)) }} />
                    </div>
                  )}
                </SpringPopover>
              </li>
            )
          })}
      </ul>
    </section>
  )
}
