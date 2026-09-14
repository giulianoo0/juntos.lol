import { describe, expect, it } from 'vitest'
import { activeCuesAt } from './activeCues'

describe('activeCuesAt', () => {
  it('picks the cues covering the time, end exclusive, in track order', () => {
    const cues = [{ startTime: 1, endTime: 3 }, { startTime: 2, endTime: 4 }, { startTime: 3, endTime: 5 }]
    expect(activeCuesAt(cues, 2.5)).toEqual([cues[0], cues[1]])
    expect(activeCuesAt(cues, 3)).toEqual([cues[1], cues[2]])
    expect(activeCuesAt(cues, 9)).toEqual([])
    expect(activeCuesAt(null, 1)).toEqual([])
  })
})
