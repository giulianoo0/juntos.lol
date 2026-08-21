import { describe, expect, it } from 'vitest'
import {
  assToWebVTT,
  convertSubtitleFile,
  decodeSubtitleText,
  isSubtitleFileName,
  srtToWebVTT,
  subtitleIdentity,
} from './subtitleFormats'

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

describe('isSubtitleFileName', () => {
  it('accepts the subtitle formats releases ship and rejects the video', () => {
    for (const name of ['a.srt', 'a.ASS', 'a.ssa', 'a.vtt', 'a.sub']) {
      expect(isSubtitleFileName(name)).toBe(true)
    }
    for (const name of ['movie.mkv', 'movie.mp4', 'readme.txt', 'poster.jpg']) {
      expect(isSubtitleFileName(name)).toBe(false)
    }
  })
})

describe('srtToWebVTT', () => {
  it('rewrites comma timings and drops the SubRip counters', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,400\nHello\n\n2\n00:01:02,500 --> 00:01:03,000\nWorld\n'
    expect(srtToWebVTT(srt)).toBe(
      'WEBVTT\n\n' +
      '00:00:01.000 --> 00:00:04.400\nHello\n\n' +
      '00:01:02.500 --> 00:01:03.000\nWorld\n',
    )
  })

  it('pads a short hour field and CRLF line endings', () => {
    const vtt = srtToWebVTT('1\r\n0:00:05,7 --> 0:00:06,25\r\nHi\r\n')
    expect(vtt).toContain('00:00:05.700 --> 00:00:06.250')
  })

  it('returns nothing when the file holds no cue', () => {
    expect(srtToWebVTT('not a subtitle at all')).toBe('')
  })
})

describe('assToWebVTT', () => {
  const script = [
    '[Script Info]',
    'Title: Example',
    '[V4+ Styles]',
    'Format: Name, Fontname',
    'Style: Default,Arial',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:04.40,Default,,0,0,0,,{\\i1}Hello, there{\\i0}\\Nfriend',
    'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,ignored',
  ].join('\n')

  it('converts dialogue lines and keeps commas inside the text field', () => {
    expect(assToWebVTT(script)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.400\n<i>Hello, there</i>\nfriend\n',
    )
  })

  it('keeps the placement and color of a styled sign', () => {
    const styled = [
      '[Script Info]',
      'PlayResX: 1920',
      'PlayResY: 1080',
      '[V4+ Styles]',
      'Format: Name, PrimaryColour, Bold, Italic, Alignment',
      'Style: Signs,&H0000FFFF,0,0,8',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(960,108)}Ateliê',
    ].join('\n')
    expect(assToWebVTT(styled)).toContain(
      '00:00:01.000 --> 00:00:02.000 line:10% position:50%\n<c.yellow>Ateliê</c>\n',
    )
  })

  it('ignores everything outside the Events section', () => {
    expect(assToWebVTT(script)).not.toContain('Arial')
    expect(assToWebVTT(script)).not.toContain('ignored')
  })

  it('reads the field order from the Format line', () => {
    const reordered = [
      '[Events]',
      'Format: Start, End, Text',
      'Dialogue: 0:00:02.00,0:00:03.00,Reordered',
    ].join('\n')
    expect(assToWebVTT(reordered)).toContain('00:00:02.000 --> 00:00:03.000\nReordered')
  })
})

describe('subtitleIdentity', () => {
  it.each([
    ['Subs/English.srt', 'eng'],
    ['show/Movie.2019.1080p.eng.srt', 'eng'],
    ['movie.pt-BR.srt', 'pt-br'],
    ['Subs/2_Japanese.ass', 'jpn'],
    ['movie.fr.srt', 'fre'],
    ['random-name.srt', 'und'],
  ])('reads the language out of %s', (path, language) => {
    expect(subtitleIdentity(path).language).toBe(language)
  })

  it('labels the track with the file name so variants stay distinguishable', () => {
    expect(subtitleIdentity('Subs/English.SDH.srt').title).toBe('English SDH')
  })
})

describe('decodeSubtitleText', () => {
  it('strips a UTF-8 byte order mark', () => {
    expect(decodeSubtitleText(bytes('﻿Olá'))).toBe('Olá')
  })

  it('falls back to windows-1252 for older releases', () => {
    // 0xE1 is a lone continuation byte in UTF-8 but "á" in windows-1252.
    const legacy = new Uint8Array([0x4f, 0x6c, 0xe1])
    expect(decodeSubtitleText(legacy.buffer as ArrayBuffer)).toBe('Olá')
  })
})

describe('convertSubtitleFile', () => {
  it('produces a WebVTT track tagged with the language from the name', () => {
    const track = convertSubtitleFile('Subs/Portuguese.srt', bytes('1\n00:00:01,000 --> 00:00:02,000\nOi\n'))
    expect(track).toEqual({
      language: 'por',
      title: 'Portuguese',
      vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:-3\nOi\n',
    })
  })

  it('rejects a bitmap VobSub payload that carries no cue', () => {
    expect(convertSubtitleFile('movie.sub', bytes('\x00\x00\x01\xba binary'))).toBeNull()
  })

  it('re-emits an existing WebVTT file with a single header', () => {
    const track = convertSubtitleFile('a.eng.vtt', bytes('WEBVTT - from a muxer\n\n00:00:01.000 --> 00:00:02.000\nHi\n'))
    expect(track?.vtt).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:-3\nHi\n')
  })
})

describe('convertSubtitleFile positioning', () => {
  it('lifts sidecar dialogue and sends the second simultaneous line to the top', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nprimeira\n\n2\n00:00:02,000 --> 00:00:05,000\nsegunda\n'
    const track = convertSubtitleFile('Subs/movie.eng.srt', new TextEncoder().encode(srt).buffer as ArrayBuffer)

    expect(track?.vtt).toContain('00:00:01.000 --> 00:00:04.000 line:-3\nprimeira')
    expect(track?.vtt).toContain('00:00:02.000 --> 00:00:05.000 line:2\nsegunda')
  })
})
