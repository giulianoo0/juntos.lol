import { Mascot, type MascotExpression } from '../mascot'
import { avatarSpec } from './avatarSpec'

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
