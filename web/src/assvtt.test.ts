import { describe, expect, it } from 'vitest'
import { convertAssCue, parseAssHeader } from './assvtt'

// A header the way Matroska CodecPrivate carries it: script info and the
// style table, no events.
const HEADER = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
    + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,'
    + ' Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Lato,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,60,60,40,1',
  'Style: Signs,Lato,48,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,60,60,40,1',
  'Style: Thoughts,Lato,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,2,2,60,60,40,1',
].join('\n')

describe('convertAssCue', () => {
  const info = parseAssHeader(HEADER)

  it('places a top-anchored style at the top of the frame in its color', () => {
    expect(convertAssCue(info, 'Signs', 'placa')).toEqual({
      settings: 'line:5%',
      text: '<c.yellow>placa</c>',
    })
  })

  it('honors an inline alignment override', () => {
    expect(convertAssCue(info, 'Default', '{\\an8}no topo')).toEqual({
      settings: 'line:5%',
      text: 'no topo',
    })
  })

  it('reads a legacy alignment override the SSA way', () => {
    // \a6 is top-center in the legacy encoding, not middle-right.
    expect(convertAssCue(info, 'Default', '{\\a6}título').settings).toBe('line:5%')
  })

  it('turns \\pos into percentages of the script frame', () => {
    // A bottom-row style anchors the text's bottom edge at the position.
    // Chromium rejects the spec's line-alignment suffix outright, so the
    // anchor is approximated by lifting the box's top edge instead.
    expect(convertAssCue(info, 'Default', '{\\pos(480,270)}placa solta').settings)
      .toBe('line:19% position:25%')
  })

  it('anchors a positioned top-aligned cue by its top edge', () => {
    expect(convertAssCue(info, 'Signs', '{\\pos(960,108)}alto').settings)
      .toBe('line:10% position:50%')
  })

  it('uses the first point of a movement', () => {
    expect(convertAssCue(info, 'Signs', '{\\move(960,108,0,0)}indo').settings)
      .toBe('line:10% position:50%')
  })

  it('aligns the side columns left and right', () => {
    expect(convertAssCue(info, 'Default', '{\\an7}canto').settings).toBe('line:5% position:5% align:left')
    expect(convertAssCue(info, 'Default', '{\\an3}outro').settings).toBe('position:95% align:right')
  })

  it('leaves bottom-center dialogue without settings', () => {
    expect(convertAssCue(info, 'Default', 'fala comum').settings).toBe('')
  })

  it('quantizes an inline color to the nearest VTT color class', () => {
    expect(convertAssCue(info, 'Default', '{\\c&H4020E0&}sangue').text).toBe('<c.red>sangue</c>')
  })

  it('closes an inline color when the override resets to the style', () => {
    expect(convertAssCue(info, 'Default', '{\\c&HFFFF00&}mar {\\c}céu').text)
      .toBe('<c.cyan>mar </c>céu')
  })

  it('returns every toggle to the style on \\r', () => {
    expect(convertAssCue(info, 'Thoughts', '{\\i0}dito {\\r}pensado').text)
      .toBe('dito <i>pensado</i>')
  })

  it('starts from the style for italics', () => {
    expect(convertAssCue(info, 'Thoughts', 'pensamento').text).toBe('<i>pensamento</i>')
  })

  it('drops vector drawings entirely', () => {
    expect(convertAssCue(info, 'Signs', '{\\p1}m 0 0 l 100 0 100 100{\\p0}').text).toBe('')
  })

  it('escapes markup-significant characters', () => {
    expect(convertAssCue(info, 'Default', 'a < b & b > c').text).toBe('a &lt; b &amp; b &gt; c')
  })

  it('handles hard breaks, soft breaks and hard spaces', () => {
    expect(convertAssCue(info, 'Default', 'um\\Ndois\\ntrês\\hquatro').text)
      .toBe('um\ndois três quatro')
  })

  it('falls back to plain bottom-center when the style is unknown', () => {
    expect(convertAssCue(info, 'Missing', 'fala')).toEqual({ settings: '', text: 'fala' })
  })

  it('reads styles from a legacy SSA header', () => {
    const legacy = [
      '[Script Info]',
      'ScriptType: v4.00',
      '[V4 Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour,'
        + ' BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment,'
        + ' MarginL, MarginR, MarginV, AlphaLevel, Encoding',
      // Decimal BGR color (yellow) and legacy top-center alignment 6.
      'Style: Top,Arial,20,65535,255,0,0,0,0,1,2,2,6,10,10,10,0,1',
    ].join('\n')
    expect(convertAssCue(parseAssHeader(legacy), 'Top', 'aviso')).toEqual({
      settings: 'line:5%',
      text: '<c.yellow>aviso</c>',
    })
  })
})
