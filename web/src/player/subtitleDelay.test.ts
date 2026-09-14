import { describe, expect, it } from 'vitest'
import { DELAY_STEP_MS, formatDelay, parseDelay, retimeCues } from './subtitleDelay'

describe('subtitle delay', () => {
  it('steps by a quarter second', () => {
    expect(DELAY_STEP_MS).toBe(250)
  })

  it('formats the delay with its sign in the room language', () => {
    expect(formatDelay(0, 'pt-BR')).toBe('0,00 s')
    expect(formatDelay(250, 'pt-BR')).toBe('+0,25 s')
    expect(formatDelay(-1500, 'pt-BR')).toBe('-1,50 s')
    expect(formatDelay(1500, 'en')).toBe('+1.50 s')
  })

  it('reads a typed value with either decimal mark, in seconds', () => {
    expect(parseDelay('1.5')).toBe(1500)
    expect(parseDelay('1,5')).toBe(1500)
    expect(parseDelay('-0,25 s')).toBe(-250)
    expect(parseDelay('+2')).toBe(2000)
    expect(parseDelay('')).toBeNull()
    expect(parseDelay('abc')).toBeNull()
  })

  it('caps a typed value at ten minutes either way', () => {
    expect(parseDelay('9999')).toBe(600_000)
    expect(parseDelay('-9999')).toBe(-600_000)
  })

  it('moves every cue of a track by the delta, keeping cues that fall before zero', () => {
    const cues = [{ startTime: 0.5, endTime: 2 }, { startTime: 10, endTime: 12 }]
    retimeCues({ cues }, -1)
    expect(cues).toEqual([{ startTime: -0.5, endTime: 1 }, { startTime: 9, endTime: 11 }])
    retimeCues({ cues: null }, 1)
  })
})
