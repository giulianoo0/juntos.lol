/**
 * What the TV plays how loud: the media (player, live, screens) and each
 * person's voice. The phone that mirrored and the TV both change it; the
 * server keeps one copy per TV.
 */
export interface Mix {
  /** 0..1. */
  media: number
  /** memberId → 0..1; absent is 1, except the owner's, absent is 0. */
  people: Record<string, number>
}

export const DEFAULT_MIX: Mix = { media: 1, people: {} }

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))

/**
 * The member the TV's account is in the room, whose voice is already in the
 * living room: the hub marks them `tv`; without the mark, the account's seat.
 */
export function ownerMemberId(members: { id: string; accountId?: number; tv?: boolean }[], accountId: number): string | null {
  const mine = members.filter((member) => member.accountId === accountId)
  return (mine.find((member) => member.tv) ?? mine[0])?.id ?? null
}

export function memberVolumes(mix: Mix, memberIds: string[], ownerId: string | null): Record<string, number> {
  const volumes: Record<string, number> = {}
  for (const id of memberIds) {
    const set = mix.people[id]
    volumes[id] = set === undefined ? (id === ownerId ? 0 : 1) : clamp(set)
  }
  return volumes
}

/** "Só a mídia": every voice off, the media as it was. */
export function onlyMedia(mix: Mix, memberIds: string[]): Mix {
  return { media: mix.media, people: Object.fromEntries(memberIds.map((id) => [id, 0])) }
}

export function withPerson(mix: Mix, memberId: string, volume: number): Mix {
  return { media: mix.media, people: { ...mix.people, [memberId]: clamp(volume) } }
}

export function withMedia(mix: Mix, volume: number): Mix {
  return { media: clamp(volume), people: mix.people }
}
