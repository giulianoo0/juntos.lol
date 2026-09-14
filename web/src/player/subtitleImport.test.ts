import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishImportedSubtitle, readSubtitleFile, SUBTITLE_FILE_ACCEPT } from './subtitleImport'

afterEach(() => vi.restoreAllMocks())

describe('subtitle import', () => {
  it('accepts the text formats the converter knows', () => {
    expect(SUBTITLE_FILE_ACCEPT).toBe('.srt,.ass,.ssa,.vtt,.sub')
  })

  it('converts a picked SRT into a track named after the file', async () => {
    const file = new File(['1\n00:00:01,000 --> 00:00:02,000\nOlá\n'], 'Filme.pt-BR.srt')
    const track = await readSubtitleFile(file)
    expect(track.vtt).toContain('00:00:01.000 --> 00:00:02.000')
    expect(track.language).toBe('pt-br')
    expect(track.title).toBe('Filme.pt-BR.srt')
    expect(track.ass).toBeUndefined()
  })

  it('keeps the ASS document next to its VTT fallback', async () => {
    const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Oi\n'
    const track = await readSubtitleFile(new File([ass], 'anime.ass'))
    expect(track.ass).toContain('[Script Info]')
    expect(track.vtt).toContain('Oi')
  })

  it('refuses a file it cannot read as text cues', async () => {
    await expect(readSubtitleFile(new File(['garbage'], 'x.sub'))).rejects.toThrow('unsupported')
    await expect(readSubtitleFile(new File(['garbage'], 'x.idx'))).rejects.toThrow('unsupported')
  })

  it('publishes a host import to the room and returns the track the server stored', async () => {
    const stored = { index: 1000, language: 'por', title: 'Filme.srt', codec: 'webvtt', digest: 'd' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ subtitleTracks: [stored] }), { status: 201 }),
    )
    const track = await publishImportedSubtitle('r1', 'm1', 2, { language: 'por', title: 'Filme.srt', vtt: 'WEBVTT\n' })
    expect(track).toEqual(stored)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/rooms/r1/subtitles/import')
    expect(JSON.parse(String(init?.body))).toEqual({ memberId: 'm1', mediaGeneration: 2, language: 'por', title: 'Filme.srt', vtt: 'WEBVTT\n' })
  })

  it('names the refusal when the server will not take the import', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"not_controller"}', { status: 403 }))
    await expect(publishImportedSubtitle('r1', 'm1', 2, { language: 'por', title: 'x', vtt: 'WEBVTT\n' })).rejects.toThrow('not_controller')
  })
})
