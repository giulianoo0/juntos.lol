import { describe, expect, it } from 'vitest'
import { throughputKbps } from './playbackHealth'

describe('throughputKbps', () => {
  it('divides the bytes by the time a download was running', () => {
    // 1 MB in 1 s is 8000 kbps.
    expect(throughputKbps([{ start: 0, end: 1000, bytes: 1_000_000 }], 1000)).toBe(8000)
  })

  it('counts overlapping downloads once in time and fully in bytes', () => {
    const transfers = [
      { start: 0, end: 1000, bytes: 500_000 },
      { start: 500, end: 1000, bytes: 500_000 },
    ]
    expect(throughputKbps(transfers, 1000)).toBe(8000)
  })

  it('leaves the idle gap between downloads out', () => {
    const transfers = [
      { start: 0, end: 1000, bytes: 1_000_000 },
      { start: 9000, end: 10000, bytes: 1_000_000 },
    ]
    expect(throughputKbps(transfers, 10000)).toBe(8000)
  })

  it('forgets downloads that ended before the window', () => {
    const transfers = [
      { start: 0, end: 1000, bytes: 9_000_000 },
      { start: 30000, end: 31000, bytes: 1_000_000 },
    ]
    expect(throughputKbps(transfers, 31000, 20000)).toBe(8000)
  })

  it('reports nothing until there is enough to measure', () => {
    expect(throughputKbps([], 1000)).toBe(0)
    expect(throughputKbps([{ start: 0, end: 100, bytes: 1000 }], 100)).toBe(0)
  })
})
