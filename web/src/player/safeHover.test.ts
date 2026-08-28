import { describe, expect, it } from 'vitest'
import { heading, inTriangle, safeTriangle } from './safeHover'

// The volume panel as it actually sits: a small box floating above the
// button, with a gap between the two that neither of them covers.
const panel = { left: 480, right: 520, top: 300, bottom: 340 }
const leftButton = { x: 500, y: 360 }

describe('safeTriangle', () => {
  it('opens onto the edge of the panel that faces the pointer', () => {
    const [from, a, b] = safeTriangle(leftButton, panel)
    expect(from).toEqual(leftButton)
    expect([a, b]).toEqual([{ x: 480, y: 340 }, { x: 520, y: 340 }])
  })

  it('turns to the side when the panel is beside the pointer', () => {
    const [, a, b] = safeTriangle({ x: 600, y: 320 }, panel)
    expect([a, b]).toEqual([{ x: 520, y: 300 }, { x: 520, y: 340 }])
  })
})

describe('heading', () => {
  it('keeps a diagonal move towards the panel', () => {
    // The move that used to lose the panel: up and across, through the gap
    // where neither the button nor the panel is hovered.
    expect(heading({ x: 494, y: 350 }, leftButton, panel)).toBe(true)
    expect(heading({ x: 488, y: 344 }, leftButton, panel)).toBe(true)
  })

  it('drops a move going the other way at once', () => {
    expect(heading({ x: 560, y: 358 }, leftButton, panel)).toBe(false)
    expect(heading({ x: 500, y: 380 }, leftButton, panel)).toBe(false)
  })

  it('holds the exit point and the panel itself', () => {
    expect(heading(leftButton, leftButton, panel)).toBe(true)
    expect(heading({ x: 500, y: 340 }, leftButton, panel)).toBe(true)
  })
})

describe('inTriangle', () => {
  it('does not care which way round the corners are given', () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, c = { x: 0, y: 10 }
    expect(inTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true)
    expect(inTriangle({ x: 2, y: 2 }, c, b, a)).toBe(true)
    expect(inTriangle({ x: 9, y: 9 }, a, b, c)).toBe(false)
  })
})
