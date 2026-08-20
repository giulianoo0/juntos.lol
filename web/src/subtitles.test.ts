import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubtitleCollector, extractAndUploadSubtitles, toWebVTT, type SubtitleCue } from './subtitles'

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

  it('turns ASS italic overrides into VTT italic tags and \\N into newlines', () => {
    const vtt = toWebVTT([{ text: '{\\i1}Hello{\\i0}\\N{\\an8}world', time: 0, duration: 1_000 }])
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000\n<i>Hello</i>\nworld\n')
  })

  it('turns ASS bold overrides into VTT bold tags', () => {
    const vtt = toWebVTT([{ text: '{\\b1}loud{\\b0} quiet', time: 0, duration: 1_000 }])
    expect(vtt).toContain('<b>loud</b> quiet')
  })

  it('reads style flags out of a block that mixes them with other overrides', () => {
    const vtt = toWebVTT([{ text: '{\\i1\\pos(20,30)}floating sign', time: 0, duration: 1_000 }])
    expect(vtt).toContain('<i>floating sign</i>')
  })

  it('closes styles left open at the end of the cue', () => {
    const vtt = toWebVTT([{ text: '{\\i1}a thought{\\b1}, emphasized', time: 0, duration: 1_000 }])
    expect(vtt).toContain('<i>a thought<b>, emphasized</b></i>')
  })

  it('ignores a close for a style that was never opened', () => {
    const vtt = toWebVTT([{ text: '{\\i0}plain words', time: 0, duration: 1_000 }])
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000\nplain words\n')
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
    await extractAndUploadSubtitles(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), 'room1', 0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts all extracted tracks as WebVTT in one request', async () => {
    await extractAndUploadSubtitles(new File(['video'], 'movie.mkv', { type: 'video/x-matroska' }), 'room1', 0)
    expect(fetch).toHaveBeenCalledWith('/api/rooms/room1/subtitles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: [{ language: 'eng', title: 'Signs', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\n' }],
        complete: true,
        mediaGeneration: 0,
      }),
    })
  })

  it('resolves silently when the server rejects the tracks', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response)
    await expect(extractAndUploadSubtitles(new File(['v'], 'movie.mkv'), 'room1', 0)).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
  })

  it('resolves silently when the request itself fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    await expect(extractAndUploadSubtitles(new File(['v'], 'movie.mkv'), 'room1', 0)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('createSubtitleCollector', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const body = (call: number) => JSON.parse(vi.mocked(fetch).mock.calls[call][1]?.body as string) as {
    tracks: Array<{ title: string }>
    complete: boolean
    mediaGeneration: number
  }

  it('names the source the tracks were read from', async () => {
    // Extraction outlives the source when the room is swapped mid-read, so
    // the post has to say which video it describes or the server cannot tell
    // it apart from one describing the video now playing.
    const collector = createSubtitleCollector('room1', 2)
    collector.publish('embedded', [{ language: 'eng', title: 'Signs', vtt: 'WEBVTT' }], true)
    await collector.flush()

    expect(body(0).mediaGeneration).toBe(2)
  })

  it('reports incomplete while any registered source is still running', async () => {
    const collector = createSubtitleCollector('room1', 0)
    collector.register('embedded')
    collector.publish('external', [{ language: 'eng', title: 'External', vtt: 'WEBVTT' }], true)
    await collector.flush()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(body(0).complete).toBe(false)
  })

  it('posts the union of every source in registration order once all are done', async () => {
    const collector = createSubtitleCollector('room1', 0)
    collector.register('external')
    collector.register('embedded')
    collector.publish('embedded', [{ language: 'jpn', title: 'Muxed', vtt: 'WEBVTT' }], true)
    collector.publish('external', [{ language: 'eng', title: 'Sibling', vtt: 'WEBVTT' }], true)
    await collector.flush()

    const last = body(vi.mocked(fetch).mock.calls.length - 1)
    expect(last.tracks.map((track) => track.title)).toEqual(['Sibling', 'Muxed'])
    expect(last.complete).toBe(true)
  })

  it('sends nothing while no source has produced a track', async () => {
    const collector = createSubtitleCollector('room1', 0)
    collector.publish('embedded', [], false)
    await collector.flush()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('coalesces progressive updates instead of posting on every publish', async () => {
    const collector = createSubtitleCollector('room1', 0)
    collector.register('embedded')
    for (let index = 0; index < 5; index += 1) {
      collector.publish('embedded', [{ language: 'eng', title: `cue ${index}`, vtt: 'WEBVTT' }], false)
    }
    await collector.flush()
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThan(5)
    // The newest snapshot must still be the one that lands.
    expect(body(vi.mocked(fetch).mock.calls.length - 1).tracks[0].title).toBe('cue 4')
  })

  it('keeps the room usable when a publish request fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const collector = createSubtitleCollector('room1', 0)
    collector.publish('external', [{ language: 'eng', title: 'External', vtt: 'WEBVTT' }], true)
    await expect(collector.flush()).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})
