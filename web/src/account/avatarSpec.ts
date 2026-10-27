import { MASCOT_KINDS, parseAvatar, type AvatarSpec } from '../mascot'

/** What an avatar string draws; '' (or one the mascot no longer knows) is a creature picked by `seed`. */
export function avatarSpec(avatar: string, seed = 0): AvatarSpec {
  return parseAvatar(avatar) ?? { kind: MASCOT_KINDS[Math.abs(seed) % MASCOT_KINDS.length]!, accessory: 'none' }
}
