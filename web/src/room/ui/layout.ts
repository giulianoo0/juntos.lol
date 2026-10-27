import type { Person, Spotlight, Stage } from '../model'

export type Target = { kind: 'stage' | 'person'; id: string }

/** How the tiles beside the focus stand: one column splitting its height,
    a column of pairs, or a strip under the stage that scrolls sideways. */
export type Arrangement = 'column' | 'pairs' | 'strip'

export type Layout =
  | { kind: 'grid'; tiles: Target[] }
  | {
    kind: 'focus'
    /** Why this is in focus: the viewer's pin, the host's spotlight, or
        simply the first stage. */
    reason: 'pin' | 'spotlight' | 'auto'
    focus: Target
    /** The column: the other stages, then the people. */
    side: Target[]
    arrange: Arrangement
  }

export interface LayoutInput {
  people: Person[]
  stages: Stage[]
  spotlight: Spotlight | null
  pin: Target | null
  /** The viewer stepped out of the host's spotlight. */
  leftSpotlight: boolean
  /** The viewer chose "Pessoas": everything as one grid, the pin aside. */
  everyone?: boolean
  /** The side panel takes the right, so the people go under the stage. */
  panelOpen?: boolean
}

function spotlightTarget(spotlight: Spotlight): Target {
  switch (spotlight.kind) {
    case 'media':
    case 'live':
      return { kind: 'stage', id: spotlight.kind }
    case 'screen':
      return { kind: 'stage', id: `screen:${spotlight.memberId}` }
    case 'member':
      return { kind: 'person', id: spotlight.memberId }
  }
}

/** What goes where: the pin, then the spotlight, then the first stage, and
    a grid of people when nothing is on stage. */
export function layoutOf({ people, stages, spotlight, pin, leftSpotlight, everyone = false, panelOpen = false }: LayoutInput): Layout {
  const all: Target[] = [
    ...stages.map(({ id }): Target => ({ kind: 'stage', id })),
    ...people.map(({ id }): Target => ({ kind: 'person', id })),
  ]
  if (everyone) return { kind: 'grid', tiles: all }
  const exists = (target: Target) => target.kind === 'stage'
    ? stages.some((stage) => stage.id === target.id)
    : people.some((member) => member.id === target.id)

  const lit = spotlight && !leftSpotlight ? spotlightTarget(spotlight) : null
  const [reason, focus]: ['pin' | 'spotlight' | 'auto', Target | null] =
    pin && exists(pin) ? ['pin', pin]
      : lit && exists(lit) ? ['spotlight', lit]
        : stages[0] ? ['auto', { kind: 'stage', id: stages[0].id }]
          : ['auto', null]

  if (!focus) return { kind: 'grid', tiles: all }

  const side = all.filter((target) => target.kind !== focus.kind || target.id !== focus.id)
  const arrange: Arrangement = panelOpen || side.length > 6 ? 'strip' : side.length > 2 ? 'pairs' : 'column'
  return { kind: 'focus', reason, focus, side, arrange }
}

/** How many columns the people grid takes. */
export function gridColumns(count: number, narrow: boolean): number {
  if (narrow) return count <= 2 ? 1 : 2
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  if (count <= 16) return 4
  return 5
}
