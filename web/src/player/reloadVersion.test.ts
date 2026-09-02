import { describe, expect, it } from 'vitest'
import { reloadVersion } from './Player'

describe('reloadVersion', () => {
  it('pins the version while the region is still growing', () => {
    expect(reloadVersion({ growing: true }, 0)).toBe(0)
    expect(reloadVersion({ growing: true }, 37)).toBe(0)
    expect(reloadVersion({ growing: true }, 512)).toBe(0)
  })

  it('keeps a finished region pinned too: the version belongs to the region being produced', () => {
    expect(reloadVersion({ growing: false }, 37)).toBe(0)
    expect(reloadVersion({}, 512)).toBe(0)
  })

  it('reads a room with no region map at its face value', () => {
    expect(reloadVersion(null, 4)).toBe(4)
    expect(reloadVersion(null, undefined)).toBe(0)
  })
})
