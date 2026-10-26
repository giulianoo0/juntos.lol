import type { CSSProperties } from 'react'
import { hueOf, initialOf } from './hue'
import styles from './Avatar.module.css'

/** A person's face without a camera: their initial on their hue. */
export function Avatar({ id, name, size = 32, className = '' }: { id: string; name: string; size?: number; className?: string }) {
  const hue = hueOf(id)
  return (
    <span
      className={`${styles.avatar} ${className}`.trim()}
      style={{ '--avatar-size': `${size}px`, '--avatar-bg': `var(--hue-${hue}-bg)`, '--avatar-ink': `var(--hue-${hue}-ink)` } as CSSProperties}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  )
}

/** Overlapping faces, at most `max`. */
export function AvatarStack({ people, size = 24, max = 3 }: { people: { id: string; name: string }[]; size?: number; max?: number }) {
  return (
    <span className={styles.stack} aria-hidden="true">
      {people.slice(0, max).map((person) => <Avatar key={person.id} id={person.id} name={person.name} size={size} className={styles.stacked} />)}
    </span>
  )
}
