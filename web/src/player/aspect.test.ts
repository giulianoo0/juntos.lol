import { describe, expect, it } from 'vitest'
import { aspectScale } from './aspect'

const wide = { width: 1600, height: 900 }
const scope = { width: 1920, height: 800 }

describe('aspectScale', () => {
  it('leaves the picture as made', () => {
    expect(aspectScale('original', wide, scope)).toEqual({ x: 1, y: 1 })
  })
  it('fills the box, cropping the sides of the picture that do not fit', () => {
    const { x, y } = aspectScale('fill', wide, scope)
    expect(x).toBeCloseTo(1.35)
    expect(y).toBeCloseTo(1.35)
  })
  it('stretches the picture over the whole box', () => {
    const { x, y } = aspectScale('stretch', wide, scope)
    expect(x).toBeCloseTo(1)
    expect(y).toBeCloseTo(1.35)
  })
  it('forces a ratio inside the box', () => {
    const fourThree = aspectScale('4:3', wide, { width: 1920, height: 1080 })
    expect(fourThree.x * 1600).toBeCloseTo(1200)
    expect(fourThree.y * 900).toBeCloseTo(900)
    const sixteenNine = aspectScale('16:9', wide, { width: 1440, height: 1080 })
    expect(sixteenNine.x * 1200).toBeCloseTo(1600)
    expect(sixteenNine.y * 900).toBeCloseTo(900)
  })
  it('waits for both sizes before scaling', () => {
    expect(aspectScale('fill', wide, { width: 0, height: 0 })).toEqual({ x: 1, y: 1 })
  })
})
