import { describe, expect, it } from 'vitest'
import { hueOf, initialOf } from './hue'

describe('hueOf', () => {
  it('gives the same person the same hue every time', () => {
    expect(hueOf('m-ana')).toBe(hueOf('m-ana'))
  })

  it('stays within the eight hues', () => {
    for (let index = 0; index < 200; index += 1) {
      const hue = hueOf(`member-${index}`)
      expect(hue).toBeGreaterThanOrEqual(1)
      expect(hue).toBeLessThanOrEqual(8)
    }
  })

  it('spreads a room of people over several hues', () => {
    const hues = new Set(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'].map(hueOf))
    expect(hues.size).toBeGreaterThanOrEqual(4)
  })
})

describe('initialOf', () => {
  it('takes the first letter, upper-cased', () => {
    expect(initialOf('ana')).toBe('A')
  })

  it('keeps an accented letter or an emoji whole', () => {
    expect(initialOf('élio')).toBe('É')
    expect(initialOf('🍿 pipoca')).toBe('🍿')
  })

  it('falls back to a question mark for an empty name', () => {
    expect(initialOf('   ')).toBe('?')
  })
})
