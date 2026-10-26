import { describe, expect, it } from 'vitest'
import { blurAt, flightStart, parseEasing } from './useSendFlight'

describe('flightStart', () => {
  it('stretches the line to the composer and centres it on the composer’s foot', () => {
    const start = flightStart({ right: 400, bottom: 800, width: 300 }, { right: 300, width: 130 })
    expect(start.scaleX).toBeCloseTo((300 - 40) / 130)
    expect(start.shiftX).toBe(400 - 52 - 300)
  })

  it('never shrinks a line wider than the composer', () => {
    expect(flightStart({ right: 400, bottom: 800, width: 200 }, { right: 400, width: 260 }).scaleX).toBe(1)
  })

  it('caps a far shift', () => {
    expect(flightStart({ right: 2000, bottom: 800, width: 300 }, { right: 300, width: 200 }).shiftX).toBe(220)
  })
})

describe('blurAt', () => {
  it('holds most of the blur through the first part, then clears', () => {
    expect(blurAt(0)).toBe(14)
    expect(blurAt(0.6)).toBeCloseTo(8.4)
    expect(blurAt(1)).toBe(0)
  })
})

describe('parseEasing', () => {
  it('reads a cubic-bezier into a progress function', () => {
    const ease = parseEasing('cubic-bezier(0.32, 0.72, 0, 1)')
    expect(ease(0)).toBeCloseTo(0)
    expect(ease(1)).toBeCloseTo(1)
    expect(ease(0.5)).toBeGreaterThan(0.8)
  })
})
