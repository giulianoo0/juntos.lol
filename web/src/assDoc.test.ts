import { describe, expect, it } from 'vitest'
import { buildAssDocument, formatAssTime, isFontAttachment } from './assDoc'

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Alignment
Style: Default,Open Sans,48,&H00FFFFFF,2

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

describe('formatAssTime', () => {
  it('writes H:MM:SS.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(61_230)).toBe('0:01:01.23')
    expect(formatAssTime(3_600_000 + 125_450)).toBe('1:02:05.45')
  })
  it('clamps negatives', () => {
    expect(formatAssTime(-500)).toBe('0:00:00.00')
  })
})

describe('buildAssDocument', () => {
  it('keeps the header and appends dialogue in time order', () => {
    const doc = buildAssDocument(HEADER, [
      { text: 'second', time: 5_000, duration: 2_000, style: 'Default', layer: '0' },
      { text: 'first {\\k20}ka{\\k30}ra', time: 1_000, duration: 3_000, style: 'Default', layer: '1', effect: 'Karaoke' },
    ])
    expect(doc).toContain('[Events]')
    const lines = doc.trim().split('\n')
    const dialogues = lines.filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(2)
    expect(dialogues[0]).toBe('Dialogue: 1,0:00:01.00,0:00:04.00,Default,,0,0,0,Karaoke,first {\\k20}ka{\\k30}ra')
    expect(dialogues[1]).toBe('Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,second')
    // Format line comes from the header, not duplicated.
    expect(doc.match(/^Format: Layer/gm)).toHaveLength(1)
  })

  it('adds an [Events] section when the header lacks one', () => {
    const doc = buildAssDocument('[Script Info]\nPlayResX: 640', [
      { text: 'hi', time: 0, duration: 1_000 },
    ])
    expect(doc).toContain('[Events]')
    expect(doc).toContain('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
    expect(doc).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hi')
  })

  it('sanitizes commas in joined fields and keeps them in text', () => {
    const doc = buildAssDocument(HEADER, [
      { text: 'a, b, c', time: 0, duration: 1_000, style: 'De,fault', name: 'x,y', marginL: 'zz' },
    ])
    const line = doc.split('\n').find((l) => l.startsWith('Dialogue:'))
    expect(line).toBe('Dialogue: 0,0:00:00.00,0:00:01.00,De;fault,x;y,0,0,0,,a, b, c')
  })

  it('drops cues with no text and survives an empty header', () => {
    const doc = buildAssDocument('', [{ text: '  ', time: 0, duration: 1_000 }])
    expect(doc).toContain('[Script Info]')
    expect(doc).not.toContain('Dialogue:')
  })
})

describe('isFontAttachment', () => {
  it('accepts font mimetypes and extensions', () => {
    expect(isFontAttachment({ mimetype: 'application/x-truetype-font', filename: 'a.bin' })).toBe(true)
    expect(isFontAttachment({ mimetype: 'font/otf' })).toBe(true)
    expect(isFontAttachment({ filename: 'OpenSans.TTF' })).toBe(true)
    expect(isFontAttachment({ filename: 'font.woff2' })).toBe(true)
  })
  it('refuses everything else', () => {
    expect(isFontAttachment({ mimetype: 'image/jpeg', filename: 'cover.jpg' })).toBe(false)
    expect(isFontAttachment({})).toBe(false)
  })
})
