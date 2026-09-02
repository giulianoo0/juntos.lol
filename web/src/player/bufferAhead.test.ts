import { describe, expect, it } from 'vitest'
import { bufferAhead, holdsForBuffer } from './bufferAhead'

describe('bufferAhead', () => {
  it('measures from the playhead, not from the start of the range', () => {
    expect(bufferAhead([{ start: 0, end: 30 }], 12)).toBe(18)
  })

  it('stops at a gap, because a gap is where playback would stop', () => {
    expect(bufferAhead([{ start: 0, end: 4 }, { start: 40, end: 56 }], 0)).toBe(4)
  })

  it('runs through ranges that meet, and through the element’s own rounding', () => {
    expect(bufferAhead([{ start: 0, end: 10 }, { start: 10.2, end: 25 }], 0)).toBe(25)
  })

  it('is zero when the playhead is past everything held', () => {
    expect(bufferAhead([{ start: 0, end: 10 }], 30)).toBe(0)
    expect(bufferAhead([], 5)).toBe(0)
  })
})

describe('holdsForBuffer', () => {
  const base = { gateSec: 10, currentTime: 0, timelineEnd: 600, playing: false, ready: true }

  it('holds while the buffer is short of the gate', () => {
    expect(holdsForBuffer({ ...base, aheadSec: 4 })).toBe(true)
  })

  it('lets go once the gate is met', () => {
    expect(holdsForBuffer({ ...base, aheadSec: 10 })).toBe(false)
  })

  it('never holds something already playing', () => {
    expect(holdsForBuffer({ ...base, aheadSec: 1, playing: true })).toBe(false)
  })

  it('never holds at the end of the film, where the seconds will never exist', () => {
    expect(holdsForBuffer({ ...base, aheadSec: 3, currentTime: 597 })).toBe(false)
  })

  it('waits for media to exist before judging it thin', () => {
    expect(holdsForBuffer({ ...base, aheadSec: 0, ready: false })).toBe(false)
  })
})
