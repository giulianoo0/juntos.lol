import { MASCOT_KINDS, Mascot, parseAvatar, type AvatarSpec, type MascotExpression } from '../mascot'

/** What an avatar string draws; '' (or one the mascot no longer knows) is a creature picked by `seed`. */
export function avatarSpec(avatar: string, seed = 0): AvatarSpec {
  return parseAvatar(avatar) ?? { kind: MASCOT_KINDS[Math.abs(seed) % MASCOT_KINDS.length]!, accessory: 'none' }
}

/** An account's face: its avatar string drawn as the mascot. */
export function AvatarFace({ avatar, seed = 0, size = 44, expression = 'idle', still = false, lookAt = null, className }: {
  avatar: string
  /** The account number, for the default creature. */
  seed?: number
  size?: number
  expression?: MascotExpression
  still?: boolean
  lookAt?: { x: number; y: number } | null
  className?: string
}) {
  const spec = avatarSpec(avatar, seed)
  return (
    <Mascot
      kind={spec.kind}
      color={spec.color}
      accessory={spec.accessory}
      expression={expression}
      size={size}
      still={still}
      lookAt={lookAt}
      className={className}
    />
  )
}
