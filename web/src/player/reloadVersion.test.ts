import { describe, expect, it } from 'vitest'
import { reloadVersion } from './Player'

describe('reloadVersion', () => {
  it('pins the version while the region is still growing', () => {
    // A growing region republishes every couple of seconds. Letting each of
    // those through rebuilt the whole player: the picture went and came back
    // while the sound carried on, over and over, the entire time a file was
    // being prepared.
    expect(reloadVersion({ growing: true }, 0)).toBe(0)
    expect(reloadVersion({ growing: true }, 37)).toBe(0)
    expect(reloadVersion({ growing: true }, 512)).toBe(0)
  })

  it('keeps a finished region pinned too: the version belongs to the region being produced', () => {
    // After a cold seek the old region seals, and every publish of the new
    // region's offset bumps the room's version. The player holding the old
    // region under its own r{n}_ name has nothing to reload for.
    expect(reloadVersion({ growing: false }, 37)).toBe(0)
    expect(reloadVersion({}, 512)).toBe(0)
  })

  it('reads a room with no region map at its face value', () => {
    expect(reloadVersion(null, 4)).toBe(4)
    expect(reloadVersion(null, undefined)).toBe(0)
  })
})
