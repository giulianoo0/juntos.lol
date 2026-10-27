import type { CSSProperties } from 'react'
import { Mascot, type MascotExpression } from '../../mascot'
import { avatarOf } from '../avatar'
import styles from './Face.module.css'

export interface FaceProps {
  id: string
  avatar?: string
  size: number
  expression?: MascotExpression
  level?: () => number
  lookAt?: { x: number; y: number } | null
  /** Holds the blinks and glances: a face among many (chat, lists) stays put. */
  still?: boolean
  className?: string
}

/** Someone's mascot: theirs, or a default one from their id. */
export function Face({ id, avatar, size, expression = 'idle', level, lookAt = null, still = true, className }: FaceProps) {
  const spec = avatarOf(avatar, id)
  return (
    <Mascot
      kind={spec.kind}
      color={spec.color}
      accessory={spec.accessory}
      expression={expression}
      level={level}
      lookAt={lookAt}
      size={size}
      still={still}
      className={className ? `${styles.face} ${className}` : styles.face}
    />
  )
}

/** Overlapping round faces, at most `max`, for the header and the door. */
export function FaceStack({ people, size = 24, max = 3 }: { people: { id: string; avatar?: string }[]; size?: number; max?: number }) {
  return (
    <span className={styles.stack} style={{ '--face-size': `${size}px` } as CSSProperties} aria-hidden="true">
      {people.slice(0, max).map((person) => (
        <span key={person.id} className={styles.disc}>
          <Face id={person.id} avatar={person.avatar} size={Math.round(size * 0.92)} />
        </span>
      ))}
    </span>
  )
}
