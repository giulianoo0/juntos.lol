import { Bell, Check, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { acceptFriend, dismissInvite, dropFriendRequest, profilePath, type AccountCard } from '../account'
import { useT } from '../i18n/useT'
import { arrive } from '../ui/arrive'
import { IconPill } from '../ui/IconPill'
import { Pill } from '../ui/Pill'
import { SpringPopover } from '../ui/SpringPopover'
import { AvatarFace } from './AvatarFace'
import { forgetNotification, refreshNotifications, useNotifications } from './notifications'
import styles from './NotificationBell.module.css'

/**
 * The bell beside the me chip: how many friend requests and room invites
 * wait, and the popover to answer them. It is only there while something
 * waits (or while it is open, so the last answer doesn't pull it away).
 */
export function NotificationBell() {
  const t = useT()
  const navigate = useNavigate()
  const notifications = useNotifications(true)
  const [open, setOpen] = useState(false)
  const requests = notifications?.friendRequests ?? []
  const invites = notifications?.invites ?? []
  const count = requests.length + invites.length
  if (count === 0 && !open) return null

  const answerRequest = (person: AccountCard, accept: boolean) => {
    forgetNotification((now) => ({ ...now, friendRequests: now.friendRequests.filter((each) => each.id !== person.id) }))
    void (accept ? acceptFriend(person.id) : dropFriendRequest(person.id)).catch(() => undefined).then(refreshNotifications)
  }
  const forgetInvite = (from: number) => {
    forgetNotification((now) => ({ ...now, invites: now.invites.filter((each) => each.from.id !== from) }))
    void dismissInvite(from).catch(() => undefined)
  }

  const label = count > 0 ? `${t('notifications.label')} (${count})` : t('notifications.label')
  return (
    <SpringPopover
      triggerRender={<button type="button" className={`${styles.bell} ${arrive}`} />}
      trigger={(
        <>
          <Bell size={18} aria-hidden="true" />
          {count > 0 ? <span className={styles.count} aria-hidden="true">{count > 9 ? '9+' : count}</span> : null}
        </>
      )}
      triggerLabel={label}
      title={t('notifications.label')}
      align="end"
      width="21rem"
      open={open}
      onOpenChange={setOpen}
    >
      {({ close }) => count === 0 ? (
        <p className={styles.empty}>{t('notifications.empty')}</p>
      ) : (
        <div className={styles.lists}>
          {requests.length > 0 ? (
            <section aria-label={t('notifications.requests')}>
              <ul className={styles.list}>
                {requests.map((person) => (
                  <li key={person.id} className={styles.row}>
                    <Link className={styles.who} to={profilePath(person.id)} onClick={close}>
                      <AvatarFace avatar={person.avatar} seed={person.id} size={32} still />
                      <span className={styles.name}>{person.nickname} <span className={styles.number}>#{person.id}</span></span>
                    </Link>
                    <IconPill size="sm" active label={`${t('account.accept')} ${person.nickname}`} icon={<Check size={15} />} onClick={() => answerRequest(person, true)} />
                    <IconPill size="sm" label={`${t('account.decline')} ${person.nickname}`} icon={<X size={15} />} onClick={() => answerRequest(person, false)} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {invites.length > 0 ? (
            <section aria-label={t('notifications.invites')}>
              <ul className={styles.list}>
                {invites.map((invite) => (
                  <li key={invite.from.id} className={styles.row}>
                    <span className={styles.who}>
                      <AvatarFace avatar={invite.from.avatar} seed={invite.from.id} size={32} still />
                      <span className={styles.name}>
                        {invite.roomName
                          ? t('notifications.invitedYouTo').replace('{name}', invite.from.nickname).replace('{room}', invite.roomName)
                          : t('notifications.invitedYou').replace('{name}', invite.from.nickname)}
                      </span>
                    </span>
                    <Pill
                      tone="brand"
                      size="sm"
                      onClick={() => { forgetInvite(invite.from.id); close(); navigate(`/room/${invite.roomId}`) }}
                    >
                      {t('notifications.join')}
                    </Pill>
                    <IconPill size="sm" label={t('notifications.dismiss')} icon={<X size={15} />} onClick={() => forgetInvite(invite.from.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </SpringPopover>
  )
}
