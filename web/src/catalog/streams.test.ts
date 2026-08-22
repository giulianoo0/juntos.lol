import { describe, expect, it } from 'vitest'
import { buildMagnet, isPlayable, parseStreams, parseStreamTitle, streamKey, streamResolution, type CatalogStream } from './streams'

describe('parseStreamTitle', () => {
  it('splits the release name from the emoji stats line', () => {
    const parsed = parseStreamTitle('The.Movie.2160p.REMUX-GROUP\n👤 109 💾 54.33 GB ⚙️ TorrentGalaxy')
    expect(parsed).toEqual({ label: 'The.Movie.2160p.REMUX-GROUP', seeders: 109, size: '54.33 GB', source: 'TorrentGalaxy', languages: [] })
  })

  it('keeps multi-line release names together and survives missing stats', () => {
    expect(parseStreamTitle('Name part one\nName part two')).toEqual({
      label: 'Name part one Name part two', seeders: null, size: '', source: '', languages: [],
    })
  })

  it('extracts language flags from the language line, keeping it out of the label', () => {
    const parsed = parseStreamTitle('Movie.1080p\n👤 12 💾 2 GB ⚙️ ThePirateBay\nMulti Subs / 🇬🇧 / 🇧🇷 / 🇪🇸')
    expect(parsed.label).toBe('Movie.1080p')
    expect(parsed.languages).toEqual(['🇬🇧', '🇧🇷', '🇪🇸'])
  })

  it('marks Brazilian dubbed releases even without a flag line', () => {
    expect(parseStreamTitle('Filme.Dublado.1080p-GRUPO\n👤 5 💾 2 GB ⚙️ Comando').languages).toEqual(['🇧🇷'])
    expect(parseStreamTitle('Movie.Dual.Audio.1080p\n👤 5 💾 2 GB ⚙️ x').languages).toEqual(['🇧🇷'])
  })
})

describe('streamResolution', () => {
  it('buckets by the addon quality tag with the release name as fallback', () => {
    expect(streamResolution('4k DV', 'Movie.2160p')).toBe('2160p')
    expect(streamResolution('', 'Movie.2160p.REMUX')).toBe('2160p')
    expect(streamResolution('1080p', 'Movie')).toBe('1080p')
    expect(streamResolution('720p', 'Movie')).toBe('720p')
    expect(streamResolution('', 'Movie.DVDRip')).toBe('sd')
  })
})

describe('parseStreams', () => {
  it('reads a torrent stream into a torrent location', () => {
    const [stream] = parseStreams({
      streams: [{
        name: 'Torrentio\n4k DV',
        title: 'Movie.2160p\n\u{1F464} 40 \u{1F4BE} 17.1 GB \u2699\uFE0F 1337x',
        infoHash: 'AD9462066CDF17273F91C4B4F708F1650394FC00',
        fileIdx: 0,
        behaviorHints: { filename: 'Movie.2160p.mkv' },
      }],
    }, 'sha-of-origin', 'Torrentio')
    expect(stream).toMatchObject({
      quality: '4k DV',
      resolution: '2160p',
      label: 'Movie.2160p',
      seeders: 40,
      size: '17.1 GB',
      source: '1337x',
      languages: [],
    })
    expect(stream.location).toEqual({
      kind: 'torrent',
      infoHash: 'ad9462066cdf17273f91c4b4f708f1650394fc00',
      fileIdx: 0,
      fileName: 'Movie.2160p.mkv',
    })
    // The id is the opaque registry key; the name is what a person reads.
    expect(stream.pluginId).toBe('sha-of-origin')
    expect(stream.pluginName).toBe('Torrentio')
  })

  it('reads a direct https url into a url location', () => {
    const [stream] = parseStreams({
      streams: [{ name: 'Mirror\n720p', title: 'Movie.720p', url: 'https://cdn.example.com/movie.mkv' }],
    }, 'p', 'Mirrors')
    expect(stream.location).toEqual({ kind: 'url', url: 'https://cdn.example.com/movie.mkv' })
    expect(stream.resolution).toBe('720p')
  })

  it('prefers the torrent when a stream carries both', () => {
    // A torrent goes through the swarm and costs nobody bandwidth; a url is
    // somebody's server. Given the choice, take the swarm.
    const [stream] = parseStreams({
      streams: [{ infoHash: 'a'.repeat(40), url: 'https://cdn.example.com/movie.mkv' }],
    }, 'p')
    expect(stream.location.kind).toBe('torrent')
  })

  it('drops a stream that points nowhere, and one that points over http', () => {
    expect(parseStreams({ streams: [{ name: 'x', title: 'y' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ url: 'http://cdn.example.com/m.mkv' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ url: 'not a url' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ infoHash: 'nothex' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ infoHash: 'a'.repeat(39) }] }, 'p')).toEqual([])
  })

  it('survives a payload that is not the shape it should be', () => {
    expect(parseStreams(null, 'p')).toEqual([])
    expect(parseStreams({ streams: 'no' }, 'p')).toEqual([])
    expect(parseStreams({ streams: [null, 42, 'x'] }, 'p')).toEqual([])
  })
})

describe('buildMagnet', () => {
  it('builds a magnet with the file name and public trackers', () => {
    const magnet = buildMagnet(
      { kind: 'torrent', infoHash: 'ad9462066cdf17273f91c4b4f708f1650394fc00', fileIdx: 0, fileName: 'Movie.mkv' },
      'Movie',
    )
    expect(magnet.startsWith('magnet:?xt=urn:btih:ad9462066cdf17273f91c4b4f708f1650394fc00')).toBe(true)
    expect(magnet).toContain('&dn=Movie.mkv')
    expect(magnet).toContain('&tr=')
  })

  it('falls back to the label when the torrent named no file', () => {
    const magnet = buildMagnet({ kind: 'torrent', infoHash: 'b'.repeat(40), fileIdx: null, fileName: '' }, 'Some Release')
    expect(magnet).toContain('&dn=Some%20Release')
  })
})

describe('streamKey', () => {
  const of = (location: CatalogStream['location'], pluginId = 'p'): CatalogStream => ({
    quality: '', resolution: 'sd', label: '', seeders: null, size: '', source: '',
    languages: [], location, pluginId, pluginName: '',
  })

  it('separates two files of the same torrent', () => {
    const at = (fileIdx: number) => streamKey(of({ kind: 'torrent', infoHash: 'a'.repeat(40), fileIdx, fileName: '' }))
    expect(at(0)).not.toBe(at(1))
  })

  it('separates a torrent from a url', () => {
    expect(streamKey(of({ kind: 'torrent', infoHash: 'a'.repeat(40), fileIdx: null, fileName: '' })))
      .not.toBe(streamKey(of({ kind: 'url', url: 'https://cdn.example.com/m.mkv' })))
  })

  it('separates the same torrent found by two different plugins', () => {
    // Having more than one plugin is the point, and two of them returning the
    // same release is the normal case, not a collision to ignore.
    const location = { kind: 'torrent' as const, infoHash: 'a'.repeat(40), fileIdx: null, fileName: '' }
    expect(streamKey(of(location, 'a'))).not.toBe(streamKey(of(location, 'b')))
  })
})

describe('isPlayable', () => {
  it('opens both kinds — a torrent through the swarm, a url through the server', () => {
    const [torrent] = parseStreams({ streams: [{ infoHash: 'a'.repeat(40) }] }, 'p')
    const [url] = parseStreams({ streams: [{ url: 'https://cdn.example.com/m.mkv' }] }, 'p')
    expect(isPlayable(torrent)).toBe(true)
    expect(isPlayable(url)).toBe(true)
  })
})

describe('readLocation, through parseStreams', () => {
  it('refuses a url carrying credentials', () => {
    // These would have the server send Basic auth to an address a plugin
    // chose — the same reason the manifest refuses them in updateUrl.
    expect(parseStreams({ streams: [{ url: 'https://user:pass@cdn.example.com/m.mkv' }] }, 'p')).toEqual([])
  })

  it('stores the url in the form it checked, not the form it was written in', () => {
    const [stream] = parseStreams({ streams: [{ url: 'https:\n//cdn.example.com/m.mkv' }] }, 'p')
    expect(stream.location).toEqual({ kind: 'url', url: 'https://cdn.example.com/m.mkv' })
  })

  it('stops at a ceiling instead of parsing whatever a plugin sends', () => {
    const many = Array.from({ length: 600 }, (_, index) => ({ infoHash: index.toString(16).padStart(40, '0') }))
    expect(parseStreams({ streams: many }, 'p')).toHaveLength(500)
  })

  it('truncates a title long enough to be a document', () => {
    const [stream] = parseStreams({ streams: [{ infoHash: 'a'.repeat(40), title: 'x'.repeat(5000) }] }, 'p')
    expect(stream.label.length).toBeLessThanOrEqual(2000)
  })
})
