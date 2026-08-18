import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractAndUploadSubtitles, toWebVTT, type SubtitleCue } from './subtitles'

describe('toWebVTT', () => {
  it('serializes cues with millisecond timings sorted by start time', () => {
    const cues: SubtitleCue[] = [
      { text: 'Second', time: 3_723_456.4, duration: 1_500 },
      { text: 'First', time: 1_000, duration: 3_000 },
    ]
    expect(toWebVTT(cues)).toBe(
      'WEBVTT\n' +
      '\n' +
      '00:00:01.000 --> 00:00:04.000\n' +
      'First\n' +
      '\n' +
      '01:02:03.456 --> 01:02:04.956\n' +
      'Second\n',
    )
  })

  it('strips ASS override tags and turns \\N into newlines', () => {
    const vtt = toWebVTT([{ text: '{\\i1}Hello{\\i0}\\N{\\an8}world', time: 0, duration: 1_000 }])
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000\nHello\nworld\n')
  })

  it('clamps negative timings to zero', () => {
    expect(toWebVTT([{ text: 'Hi', time: -5, duration: 500 }])).toContain('00:00:00.000 --> 00:00:00.495')
  })
})

describe('extractAndUploadSubtitles', () => {
  type Listener = (...args: never[]) => void

  class FakeParser {
    listeners = new Map<string, Listener[]>()
    once(event: string, listener: Listener) { this.on(event, listener) }
    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    }
    resume() {}
    write() {}
    end() {
      this.emit('tracks', [{ number: 3, language: 'eng', name: 'Signs', type: 'utf8' }] as never)
      this.emit('subtitle', { text: 'Hello', time: 1_000, duration: 3_000 } as never, 3 as never)
      this.emit('finish')
    }
    private emit(event: string, ...args: never[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }

  beforeEach(() => {
    vi.stubGlobal('MatroskaSubtitles', { SubtitleParser: FakeParser })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does nothing for non-Matroska files', async () => {
    await extractAndUploadSubtitles(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), 'room1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts all extracted tracks as WebVTT in one request', async () => {
    await extractAndUploadSubtitles(new File(['video'], 'movie.mkv', { type: 'video/x-matroska' }), 'room1')
    expect(fetch).toHaveBeenCalledWith('/api/rooms/room1/subtitles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: [{ language: 'eng', title: 'Signs', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\n' }],
      }),
    })
  })

  it('resolves silently when the server rejects the tracks', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response)
    await expect(extractAndUploadSubtitles(new File(['v'], 'movie.mkv'), 'room1')).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
  })

  it('resolves silently when the request itself fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    await expect(extractAndUploadSubtitles(new File(['v'], 'movie.mkv'), 'room1')).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})
