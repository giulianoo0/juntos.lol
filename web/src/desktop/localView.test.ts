import { describe, expect, it } from 'vitest'
import { localStatus, playableRoom } from './localView'
import type { RoomInfo } from '../types'

const room = { id: 'R', status: 'local', mediaGeneration: 2, fileName: 'Filme', controllerId: 'h', audioTracks: null, subtitleTracks: null, bitmapSubsSkipped: 0, memberCount: 2, expiresAt: '' } as RoomInfo
const regions = [{ n: 0, startMs: 0, producedMs: 8000, growing: true }]
const local = { root: 'juntos-media://localhost/k', generation: 2, regions }

describe('the room as the desktop host plays it', () => {
  it('is ready the moment the cache has a region of this generation', () => {
    expect(localStatus('local', local, 2)).toBe('ready')
    expect(localStatus('uploading', local, 2)).toBe('ready')
  })

  it('is preparing while the cache has nothing yet', () => {
    expect(localStatus('local', { ...local, regions: [] }, 2)).toBe('processing')
    expect(localStatus('local', { ...local, regions: [{ ...regions[0], producedMs: 0 }] }, 2)).toBe('processing')
  })

  it('a guest without the cache sees the local room as preparing, not as an error', () => {
    expect(localStatus('local', null, 2)).toBe('uploading')
    expect(localStatus('ready', null, 2)).toBe('ready')
  })

  it('a cache of another generation is not this room', () => {
    expect(localStatus('local', local, 3)).toBe('uploading')
    expect(playableRoom({ ...room, mediaGeneration: 3 }, local)).toEqual({ room: { ...room, mediaGeneration: 3 }, mediaRoot: undefined })
  })

  it('plays the cache regions from the cache root', () => {
    const played = playableRoom(room, local)
    expect(played.mediaRoot).toBe('juntos-media://localhost/k')
    expect(played.room.mediaRegions).toEqual(regions)
    expect(played.room.status).toBe('ready')
  })
})
