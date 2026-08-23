import { describe, expect, it } from 'vitest'
import { episodePattern, pickStreamFile } from './openStream'
import type { StreamLocation } from './streams'
import type { TorrentVideoFile } from '../torrent'

type TorrentLocation = Extract<StreamLocation, { kind: 'torrent' }>

const location = (over: Partial<TorrentLocation> = {}): TorrentLocation => ({
  kind: 'torrent',
  infoHash: 'b43df67a93863ea91f2f773f00361072da771dd3',
  fileIdx: null,
  fileName: '',
  ...over,
})

// The picker only reads name, path, index and size; the rest of the file is
// the reading machinery it never touches.
const file = (index: number, path: string, size = 1_000): TorrentVideoFile => ({
  name: path.split('/').pop() ?? path,
  path,
  index,
  size,
  type: 'application/octet-stream',
  progress: 0,
  downloaded: 0,
  read: async () => new ArrayBuffer(0),
})

// A five-season pack, sorted largest-first the way a session hands them over.
const pack = [
  file(245, 'Season 1/Show (2008) - S01E01 - Pilot (1080p BluRay).mkv', 9_000),
  file(246, 'Season 1/Show (2008) - S01E02 - Cat in the Bag (1080p BluRay).mkv', 8_000),
  file(310, 'Season 2/Show (2008) - S02E11 - Mandala (1080p BluRay).mkv', 7_000),
]

describe('episodePattern', () => {
  it('reads the usual season/episode spellings', () => {
    const pattern = episodePattern(1, 2)
    expect(pattern.test('Show.S01E02.1080p.mkv')).toBe(true)
    expect(pattern.test('Show s1.e2 1080p.mkv')).toBe(true)
    expect(pattern.test('Show 1x02 1080p.mkv')).toBe(true)
    expect(pattern.test('Show.S01.EP02.1080p.mkv')).toBe(true)
  })

  it('does not let episode 1 match episode 11', () => {
    const pattern = episodePattern(1, 1)
    expect(pattern.test('Show.S01E11.1080p.mkv')).toBe(false)
    expect(pattern.test('Show.S01E01.1080p.mkv')).toBe(true)
  })

  it('keeps the seasons apart', () => {
    expect(episodePattern(1, 2).test('Show.S02E02.mkv')).toBe(false)
  })
})

describe('pickStreamFile', () => {
  it('takes the addon filename hint when it names a file in the torrent', () => {
    const picked = pickStreamFile(pack, location({
      fileName: 'Show (2008) - S02E11 - Mandala (1080p BluRay).mkv',
      fileIdx: 0,
    }), { type: 'series', id: 'tt0903747', season: 2, episode: 11 })
    expect(picked?.index).toBe(310)
  })

  it('finds the episode by name when the hint matches nothing — fileIdx 0 on a season pack is not the episode', () => {
    const picked = pickStreamFile(pack, location({
      fileName: 'Show.S02E11.DIFFERENT.RELEASE.mkv',
      fileIdx: 0,
    }), { type: 'series', id: 'tt0903747', season: 2, episode: 11 })
    expect(picked?.index).toBe(310)
  })

  it('prefers the larger copy when a pack carries the episode twice', () => {
    const withSample = [
      file(9, 'Samples/Show.S01E02.sample.mkv', 40),
      ...pack,
    ]
    const picked = pickStreamFile(withSample, location(), { type: 'series', id: 'tt0903747', season: 1, episode: 2 })
    expect(picked?.index).toBe(246)
  })

  it('falls back to the addon index when nothing names the episode', () => {
    const picked = pickStreamFile(pack, location({ fileIdx: 246 }))
    expect(picked?.index).toBe(246)
  })

  it('takes the only file of a single-video release without consulting anything', () => {
    const single = [file(0, 'Movie.2160p.REMUX.mkv')]
    expect(pickStreamFile(single, location({ fileIdx: 7, fileName: 'other.mkv' }))?.index).toBe(0)
  })

  it('has nothing to give when the torrent holds no video', () => {
    expect(pickStreamFile([], location())).toBeUndefined()
  })
})
