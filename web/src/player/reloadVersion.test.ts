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

  it('lets a finished region reload, which is what the version is for', () => {
    // The final remux replacing the progressive preview: same URL, new bytes,
    // and the only way a preview viewer is handed the finished playlists.
    expect(reloadVersion({ growing: false }, 37)).toBe(37)
  })

  it('reads a room with no region map at its face value', () => {
    expect(reloadVersion(null, 4)).toBe(4)
    expect(reloadVersion(null, undefined)).toBe(0)
  })
})
