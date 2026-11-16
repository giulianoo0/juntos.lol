import { useState } from 'react'
import { discordAvatarUrl, type Friend } from '../account'
import { AvatarFace } from '../account/AvatarFace'
import { whereabouts } from './friends'
import styles from './FriendFace.module.css'

/**
 * A friend's creature with where they are drawn on it: a ring while juntos is
 * open (brand while in a room), and their Discord picture tucked under it,
 * dotted with their Discord status.
 */
export function FriendFace({ friend, size = 44 }: { friend: Friend; size?: number }) {
  const where = whereabouts(friend)
  const discord = friend.presence.discord
  const [broken, setBroken] = useState(false)
  const mini = Math.round(size * 0.46)
  return (
    <span className={styles.face} data-where={where} style={{ width: size, height: size }}>
      <span className={styles.ring} aria-hidden="true" />
      <AvatarFace avatar={friend.avatar} seed={friend.id} size={size} still={where === 'away'} className={styles.creature} />
      {broken ? null : (
        <span className={styles.discord} data-status={discord ?? 'offline'} style={{ width: mini, height: mini }} aria-hidden="true">
          <img src={discordAvatarUrl(friend.id)} alt="" width={mini} height={mini} loading="lazy" decoding="async" onError={() => setBroken(true)} />
          <span className={styles.dot} />
        </span>
      )}
    </span>
  )
}
