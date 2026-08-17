import { describe, expect, it } from 'vitest'
import { expectedPositionMs, needsResync } from './position'

describe('position math', () => {
  it('projects playing state and keeps paused state fixed', () => {
    expect(expectedPositionMs({ playing: true, positionMs: 10_000, rate: 1, serverTimeMs: 1_000_000 }, 1_002_000)).toBe(12_000)
    expect(expectedPositionMs({ playing: false, positionMs: 10_000, rate: 1, serverTimeMs: 1_000_000 }, 1_999_999)).toBe(10_000)
  })

  it('uses a strict 450ms drift threshold', () => {
    expect(needsResync(10_000, 10_450)).toBe(false)
    expect(needsResync(10_000, 10_451)).toBe(true)
  })
})
