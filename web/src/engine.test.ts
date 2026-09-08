import { describe, expect, it } from 'vitest'
import { detectGecko } from './engine'

const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

describe('detectGecko', () => {
  it('sees Firefox by its Gecko build token', () => {
    expect(detectGecko(FIREFOX, () => false)).toBe(true)
  })

  it('is not fooled by browsers that are merely "like Gecko"', () => {
    expect(detectGecko(CHROME, () => false)).toBe(false)
    expect(detectGecko(SAFARI, () => false)).toBe(false)
  })

  it('falls back to the -moz- property probe when the agent string is hidden', () => {
    expect(detectGecko('', (property) => property === '-moz-appearance')).toBe(true)
    expect(detectGecko('', () => { throw new Error('no CSS here') })).toBe(false)
  })
})
