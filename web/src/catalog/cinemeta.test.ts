import { describe, expect, it } from 'vitest'
import { parseCatalogMetas, parseMetaDetail } from './cinemeta'

describe('parseCatalogMetas', () => {
  it('keeps only entries a poster card can render', () => {
    const metas = parseCatalogMetas({
      metas: [
        { id: 'tt1', type: 'movie', name: 'One', poster: 'p1', releaseInfo: '2020' },
        { id: '', type: 'movie', name: 'No id' },
        { id: 'tt2', name: 'Typeless' },
        { id: 'tt3', type: 'other', name: 'Weird type' },
        'garbage',
        { id: 'tt4', type: 'series', name: 'Four' },
      ],
    })
    expect(metas).toEqual([
      { id: 'tt1', type: 'movie', name: 'One', poster: 'p1', releaseInfo: '2020' },
      { id: 'tt4', type: 'series', name: 'Four', poster: '', releaseInfo: '' },
    ])
  })

  it('falls back to the requested type when entries omit theirs', () => {
    const metas = parseCatalogMetas({ metas: [{ id: 'tt2', name: 'Typeless' }] }, 'series')
    expect(metas).toEqual([{ id: 'tt2', type: 'series', name: 'Typeless', poster: '', releaseInfo: '' }])
  })

  it('returns nothing for malformed payloads', () => {
    expect(parseCatalogMetas(null)).toEqual([])
    expect(parseCatalogMetas({ metas: 'no' })).toEqual([])
  })
})

describe('parseMetaDetail', () => {
  it('extracts the detail page fields, dropping malformed videos', () => {
    const detail = parseMetaDetail({
      meta: {
        id: 'tt0903747', type: 'series', name: 'Breaking Bad',
        poster: 'p', background: 'b', logo: 'l', description: 'd',
        runtime: '49 min', imdbRating: '9.5', releaseInfo: '2008-2013',
        genre: ['Crime', 'Drama'], cast: ['Bryan Cranston'], director: [],
        videos: [
          { id: 'tt0903747:1:1', season: 1, episode: 1, name: 'Pilot', released: '2008-01-20' },
          { id: 'broken', season: '1', episode: 1 },
        ],
      },
    })
    expect(detail).not.toBeNull()
    expect(detail?.name).toBe('Breaking Bad')
    expect(detail?.genres).toEqual(['Crime', 'Drama'])
    expect(detail?.videos).toEqual([
      { id: 'tt0903747:1:1', season: 1, episode: 1, name: 'Pilot', released: '2008-01-20', thumbnail: undefined, overview: undefined },
    ])
  })

  it('rejects payloads without an identifiable meta', () => {
    expect(parseMetaDetail({})).toBeNull()
    expect(parseMetaDetail({ meta: { id: 'tt1', type: 'movie' } })).toBeNull()
  })
})
