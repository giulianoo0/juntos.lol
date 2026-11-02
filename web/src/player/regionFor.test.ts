import { describe, expect, it } from 'vitest'
import { regionFor } from './Player'
import { regionHas } from './regions'
import type { MediaRegion } from '../types'

const r = (n: number, startMs: number, producedMs: number, growing = false): MediaRegion => ({ n, startMs, producedMs, growing })

describe('regionFor', () => {
  const map = [r(0, 0, 24_000), r(1, 599_600, 40_000), r(2, 23_900, 200_000, true)]

  it('picks the region holding the time, newest start first', () => {
    expect(regionFor(map, 10_000, null)).toBe(0)
    expect(regionFor(map, 610_000, null)).toBe(1)
    expect(regionFor(map, 100_000, null)).toBe(2)
    expect(regionFor(map, 23_950, null)).toBe(2)
  })

  it('stays on the loaded region while it still holds the time', () => {
    expect(regionFor(map, 23_950, 0), 'region 0 still holds 23.95s').toBe(0)
    expect(regionFor(map, 30_000, 0), 'past region 0 it must move').toBe(2)
  })

  it('a growing region reaches ahead of what it produced', () => {
    expect(regionFor(map, 240_000, null), 'within the growing margin').toBe(2)
    expect(regionFor(map, 400_000, null), 'far ahead still belongs to the growing region').toBe(2)
  })

  it('a hole with nothing growing keeps the loaded region', () => {
    const finished = [r(0, 0, 24_000), r(1, 599_600, 40_000)]
    expect(regionFor(finished, 300_000, 0)).toBe(0)
    expect(regionFor(finished, 300_000, null), 'nothing loaded falls back to the last region').toBe(1)
  })

  it('an empty map has no answer', () => {
    expect(regionFor([], 0, null)).toBeNull()
  })
})

describe('regionHas', () => {
  it('does not count a region that just opened as having the target, though it holds it', () => {
    const opened = r(1, 598_598, 0, true)
    expect(regionHas(opened, 600_000, 3000)).toBe(false)
    expect(regionHas(r(1, 598_598, 4_000, true), 600_000, 3000)).toBe(false)
    expect(regionHas(r(1, 598_598, 4_500, true), 600_000, 3000)).toBe(true)
  })

  it('takes a finished region up to its last frame', () => {
    expect(regionHas(r(0, 0, 24_000), 23_500, 3000)).toBe(true)
    expect(regionHas(r(0, 0, 24_000), 24_500, 3000)).toBe(false)
  })

  it('never reaches back before the region starts', () => {
    expect(regionHas(r(2, 100_000, 60_000, true), 50_000, 3000)).toBe(false)
  })
})
