import { describe, expect, it } from 'vitest'
import type { Person, Stage } from '../model'
import { gridColumns, layoutOf } from './layout'

const person = (id: string): Person => ({
  id, name: id, host: false, mic: false, cam: false, speaking: false, hostMuted: false, hostCamOff: false,
})
const people = ['giu', 'ana', 'bruno'].map(person)
const media: Stage = { id: 'media', kind: 'media', title: 'Duna', ownerId: 'giu' }
const screen: Stage = { id: 'screen:bruno', kind: 'screen', title: 'Tela de Bruno', ownerId: 'bruno' }

describe('layoutOf', () => {
  it('shows everyone in a grid when nothing is on stage', () => {
    expect(layoutOf({ people, stages: [], spotlight: null, pin: null, leftSpotlight: false })).toEqual({
      kind: 'grid',
      tiles: people.map(({ id }) => ({ kind: 'person', id })),
    })
  })

  it('puts the first stage in focus, the other stages then the people beside it', () => {
    const layout = layoutOf({ people, stages: [media, screen], spotlight: null, pin: null, leftSpotlight: false })
    expect(layout).toEqual({
      kind: 'focus',
      reason: 'auto',
      focus: { kind: 'stage', id: 'media' },
      side: [{ kind: 'stage', id: 'screen:bruno' }, ...people.map(({ id }) => ({ kind: 'person', id }))],
      arrange: 'pairs',
    })
  })

  it('follows the host spotlight over the order of the stages', () => {
    const layout = layoutOf({ people, stages: [media, screen], spotlight: { kind: 'screen', memberId: 'bruno' }, pin: null, leftSpotlight: false })
    expect(layout.kind === 'focus' && layout.focus).toEqual({ kind: 'stage', id: 'screen:bruno' })
    expect(layout.kind === 'focus' && layout.reason).toBe('spotlight')
  })

  it('brings a spotlit person to the focus, out of the column', () => {
    const layout = layoutOf({ people, stages: [], spotlight: { kind: 'member', memberId: 'ana' }, pin: null, leftSpotlight: false })
    expect(layout).toEqual({
      kind: 'focus',
      reason: 'spotlight',
      focus: { kind: 'person', id: 'ana' },
      side: [{ kind: 'person', id: 'giu' }, { kind: 'person', id: 'bruno' }],
      arrange: 'column',
    })
  })

  it('lets a viewer who left the spotlight see the room as without it', () => {
    const layout = layoutOf({ people, stages: [], spotlight: { kind: 'member', memberId: 'ana' }, pin: null, leftSpotlight: true })
    expect(layout.kind).toBe('grid')
  })

  it('puts what the viewer pinned above the spotlight', () => {
    const layout = layoutOf({ people, stages: [media], spotlight: { kind: 'media' }, pin: { kind: 'person', id: 'bruno' }, leftSpotlight: false })
    expect(layout.kind === 'focus' && layout.focus).toEqual({ kind: 'person', id: 'bruno' })
    expect(layout.kind === 'focus' && layout.reason).toBe('pin')
  })

  it('forgets a pin or a spotlight on something that is gone', () => {
    const layout = layoutOf({ people, stages: [], spotlight: { kind: 'live' }, pin: { kind: 'stage', id: 'media' }, leftSpotlight: false })
    expect(layout.kind).toBe('grid')
  })
})

describe('the people beside a stage', () => {
  const crowd = (count: number) => Array.from({ length: count }, (_, index) => person(`p${index}`))
  const arrangeOf = (count: number, panelOpen = false) => {
    const layout = layoutOf({ people: crowd(count), stages: [media], spotlight: null, pin: null, leftSpotlight: false, panelOpen })
    return layout.kind === 'focus' ? layout.arrange : null
  }

  it('stand in one column for one or two, splitting its height', () => {
    expect([1, 2].map((count) => arrangeOf(count))).toEqual(['column', 'column'])
  })

  it('pair up in the column from three to six', () => {
    expect([3, 6].map((count) => arrangeOf(count))).toEqual(['pairs', 'pairs'])
  })

  it('move to a strip under the stage from seven', () => {
    expect(arrangeOf(7)).toBe('strip')
  })

  it('move to the strip whenever the panel takes the right', () => {
    expect([1, 4].map((count) => arrangeOf(count, true))).toEqual(['strip', 'strip'])
  })
})

describe('gridColumns', () => {
  it('fits 1, 2, 6 and 12 people on a wide screen', () => {
    expect([1, 2, 6, 12].map((count) => gridColumns(count, false))).toEqual([1, 2, 3, 4])
  })

  it('stacks on a phone: one column for two, two columns from three', () => {
    expect([1, 2, 3, 6, 12].map((count) => gridColumns(count, true))).toEqual([1, 1, 2, 2, 2])
  })
})
