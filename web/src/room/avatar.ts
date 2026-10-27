import { MASCOT_KINDS, parseAvatar, type AvatarSpec, type MascotExpression } from '../mascot'

const PICKED_KEY = 'ss.avatar'

function hashOf(text: string): number {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return hash >>> 0
}

/** The member's avatar, or for someone without one a default picked by `seed`
    (their id), so everyone sees the same face for them. */
export function avatarOf(avatar: string | undefined, seed: string): AvatarSpec {
  const parsed = avatar ? parseAvatar(avatar) : null
  return parsed ?? { kind: MASCOT_KINDS[hashOf(seed) % MASCOT_KINDS.length]!, accessory: 'bowtie' }
}

/** The avatar this browser picked at the door; null for none (or one it cannot draw). */
export function loadPickedAvatar(): string | null {
  try {
    const stored = localStorage.getItem(PICKED_KEY)
    return stored && parseAvatar(stored) ? stored : null
  } catch {
    return null
  }
}

export function savePickedAvatar(avatar: string): void {
  try {
    localStorage.setItem(PICKED_KEY, avatar)
  } catch {
    // Private mode: the pick lasts the visit.
  }
}

const MOODS: Record<string, MascotExpression> = {
  '😂': 'happy',
  '❤️': 'happy',
  '🔥': 'happy',
  '👏': 'happy',
  '😮': 'thinking',
}

/** How a face answers its own reaction; null leaves it as it was. */
export function reactionMood(emoji: string): MascotExpression | null {
  return MOODS[emoji] ?? null
}
