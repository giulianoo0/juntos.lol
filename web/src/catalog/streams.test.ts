import { describe, expect, it } from 'vitest'
import { buildMagnet, parseStreams, parseStreamTitle, streamResolution } from './streams'

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
  it('accepts torrent streams and drops anything without a valid infoHash', () => {
    const streams = parseStreams({
      streams: [
        {
          name: 'Torrentio\n4k DV',
          title: 'Movie.2160p\n👤 40 💾 17.1 GB ⚙️ 1337x',
          infoHash: 'AD9462066CDF17273F91C4B4F708F1650394FC00',
          fileIdx: 0,
          behaviorHints: { filename: 'Movie.2160p.mkv' },
        },
        { name: 'HTTP', title: 'external', url: 'https://elsewhere/video' },
        { infoHash: 'short' },
      ],
    })
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({
      quality: '4k DV',
      resolution: '2160p',
      label: 'Movie.2160p',
      seeders: 40,
      size: '17.1 GB',
      source: '1337x',
      languages: [],
      infoHash: 'ad9462066cdf17273f91c4b4f708f1650394fc00',
      fileName: 'Movie.2160p.mkv',
    })
  })
})

describe('buildMagnet', () => {
  it('builds a magnet with the file name and public trackers', () => {
    const magnet = buildMagnet({
      quality: '1080p', resolution: '1080p', label: 'Movie', seeders: 1, size: '1 GB', source: 'x', languages: [], fileIdx: 0,
      infoHash: 'ad9462066cdf17273f91c4b4f708f1650394fc00', fileName: 'Movie.mkv',
    })
    expect(magnet.startsWith('magnet:?xt=urn:btih:ad9462066cdf17273f91c4b4f708f1650394fc00')).toBe(true)
    expect(magnet).toContain('&dn=Movie.mkv')
    expect(magnet).toContain('&tr=')
  })
})
