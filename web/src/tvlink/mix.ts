import type { Mix } from './api'

/**
 * Someone's level in a TV's mix. Absent is 1, except for the TV's owner
 * (the one who mirrored): 0, so the room does not hear itself twice.
 */
export function levelIn(mix: Mix, memberId: string, ownerId: string): number {
  return mix.people[memberId] ?? (memberId === ownerId ? 0 : 1)
}

/** The mix with `memberId` at `level`; the owner's default written out, so the TV keeps it. */
export function withLevel(mix: Mix, memberId: string, level: number, ownerId: string): Mix {
  return { ...mix, people: { [ownerId]: levelIn(mix, ownerId, ownerId), ...mix.people, [memberId]: level } }
}

/** "Só a mídia": everyone in the room, and anyone the mix remembers, at 0. */
export function onlyMedia(mix: Mix, memberIds: string[]): Mix {
  const people: Record<string, number> = {}
  for (const id of [...memberIds, ...Object.keys(mix.people)]) people[id] = 0
  return { ...mix, people }
}
