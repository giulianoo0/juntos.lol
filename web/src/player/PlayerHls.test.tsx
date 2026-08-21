import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import type { RoomInfo } from '../types'
import { Player } from './Player'

// A controllable stand-in for hls.js: tests drive the exact event sequences
// the real library emits when a browser cannot decode a stream.
vi.mock('hls.js', () => {
  type Handler = (event: string, data: Record<string, unknown>) => void
  class FakeLoader {
    lastContext: Record<string, unknown> | null = null
    lastCallbacks: Record<string, (...args: unknown[]) => void> | null = null
    load(context: Record<string, unknown>, _config: unknown, callbacks: Record<string, (...args: unknown[]) => void>) {
      this.lastContext = context
      this.lastCallbacks = callbacks
    }
  }
  class FakeHls {
    static instances: FakeHls[] = []
    static isSupported = () => true
    static Events = {
      MEDIA_ATTACHED: 'hlsMediaAttached',
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVELS_UPDATED: 'hlsLevelsUpdated',
      AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
      BUFFER_CREATED: 'hlsBufferCreated',
      ERROR: 'hlsError',
    }
    static DefaultConfig = { loader: FakeLoader }
    config: Record<string, unknown>
    handlers = new Map<string, Handler[]>()
    levels: Array<{ videoCodec?: string; audioCodec?: string; width?: number; height?: number }> = []
    audioTracks: unknown[] = []
    destroyed = false
    loadedSource: string | null = null
    loadSourceCalls = 0
    startLoadCalls = 0
    recoverCalls = 0
    constructor(config: Record<string, unknown>) {
      this.config = config
      FakeHls.instances.push(this)
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    emit(event: string, data: Record<string, unknown>) {
      for (const handler of this.handlers.get(event) ?? []) handler(event, data)
    }
    loadSource(url: string) { this.loadedSource = url; this.loadSourceCalls += 1 }
    attachMedia() { this.emit(FakeHls.Events.MEDIA_ATTACHED, {}) }
    startLoad() { this.startLoadCalls += 1 }
    recoverMediaError() { this.recoverCalls += 1 }
    destroy() { this.destroyed = true }
  }
  return {
    default: FakeHls,
    ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' },
    ErrorDetails: {
      BUFFER_INCOMPATIBLE_CODECS_ERROR: 'bufferIncompatibleCodecsError',
      BUFFER_ADD_CODEC_ERROR: 'bufferAddCodecError',
      MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError',
    },
  }
})

interface FakeHlsInstance {
  config: {
    startPosition?: number
    pLoader?: new (config: unknown) => {
      load: (context: unknown, config: unknown, callbacks: unknown) => void
      lastCallbacks: { onSuccess: (response: { data: string }, stats: unknown, context: unknown, network: unknown) => void } | null
    }
  }
  levels: Array<{ videoCodec?: string; audioCodec?: string }>
  destroyed: boolean
  loadedSource: string | null
  loadSourceCalls: number
  recoverCalls: number
  emit: (event: string, data: Record<string, unknown>) => void
}

const fakeHls = async () => (await import('hls.js')).default as unknown as { instances: FakeHlsInstance[] }

const t = Object.assign((key: string) => translate('en', key), {
  language: 'en' as const,
  setLanguage: vi.fn(),
}) as Translator

const room: RoomInfo = {
  id: 'r1',
  fileName: 'movie.mkv',
  status: 'ready',
  sourceKind: 'upload',
  mediaGeneration: 3,
  mediaVersion: 0,
  subsVersion: 0,
  controllerId: 'm1',
  audioTracks: null,
  subtitleTracks: null,
  bitmapSubsSkipped: 0,
  memberCount: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
}

const unplayableMessage = translate('en', 'room.unplayable')

async function renderPlayer(override: Partial<RoomInfo> = {}) {
  const videoRef = createRef<HTMLVideoElement>()
  const view = render(
    <Player room={{ ...room, ...override }} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
  )
  const hls = await fakeHls()
  await waitFor(() => expect(hls.instances.length).toBeGreaterThan(0))
  return { videoRef, view, hls }
}

describe('Player HLS lifecycle', () => {
  beforeEach(async () => {
    (await fakeHls()).instances.length = 0
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('does not reload the source when the media re-attaches after a recovery', async () => {
    // hls.js's recoverMediaError re-attaches the media and resumes loading at
    // the pre-error position itself. Reloading the source on that second
    // MEDIA_ATTACHED resets playback to the configured start position, which
    // viewers saw as a jump to 0:00 before the sync dragged them back.
    const { hls } = await renderPlayer()
    const instance = hls.instances[0]

    act(() => instance.emit('hlsError', { fatal: true, type: 'mediaError', details: 'bufferStalledError' }))
    act(() => instance.emit('hlsMediaAttached', {}))

    expect(instance.recoverCalls).toBe(1)
    expect(instance.loadSourceCalls).toBe(1)
  })

  it('declares the room unplayable when hls.js drops the only video rendition', async () => {
    const { view, hls } = await renderPlayer()
    const instance = hls.instances[0]
    instance.levels = [{ videoCodec: 'hvc1.2.4.L120.90', audioCodec: 'mp4a.40.2' }]

    // hls.js emits this as NON-fatal, deletes the video track and keeps the
    // audio group playing; before the fix the player ignored it entirely.
    act(() => instance.emit('hlsError', {
      fatal: false,
      type: 'mediaError',
      details: 'bufferAddCodecError',
      sourceBufferName: 'video',
      mimeType: 'video/mp4;codecs=hvc1.2.4.L120.90',
    }))

    expect(view.getByRole('alert')).toHaveTextContent(unplayableMessage)
    expect(instance.destroyed).toBe(true)
    expect(console.error).toHaveBeenCalledWith('[ss-player]', expect.stringContaining('giving up'))
  })

  it('stays quiet about a dropped codec while another video rendition remains', async () => {
    const { view, hls } = await renderPlayer()
    const instance = hls.instances[0]
    // The state after hls.js removed the failing level itself.
    instance.levels = [{ videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2' }]

    act(() => instance.emit('hlsError', {
      fatal: false,
      type: 'mediaError',
      details: 'bufferAddCodecError',
      sourceBufferName: 'video',
      mimeType: 'video/mp4;codecs=hvc1.2.4.L120.90',
    }))

    expect(view.queryByRole('alert')).not.toBeInTheDocument()
    expect(instance.destroyed).toBe(false)
  })

  it('retries a fully rejected manifest without codec strings before giving up', async () => {
    const { view, hls } = await renderPlayer()
    const first = hls.instances[0]

    act(() => first.emit('hlsError', {
      fatal: true,
      type: 'mediaError',
      details: 'manifestIncompatibleCodecsError',
    }))

    expect(first.destroyed).toBe(true)
    expect(view.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(hls.instances.length).toBe(2))
    const second = hls.instances[1]
    const LoaderClass = second.config.pLoader
    expect(LoaderClass).toBeDefined()

    // The retry loader must hand hls.js a manifest with the prediction gone.
    const loader = new LoaderClass!({})
    const delivered: string[] = []
    loader.load({ type: 'manifest' }, {}, {
      onSuccess: (response: { data: string }) => delivered.push(response.data),
    })
    loader.lastCallbacks!.onSuccess(
      { data: '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1.2.4.L120.B01,mp4a.40.2",RESOLUTION=1920x1080\ns.m3u8\n' },
      {}, { type: 'manifest' }, null,
    )
    expect(delivered[0]).not.toContain('CODECS')
    expect(delivered[0]).toContain('RESOLUTION=1920x1080')

    // A second rejection, now free of wrong strings, is the real verdict.
    act(() => second.emit('hlsError', {
      fatal: true,
      type: 'mediaError',
      details: 'manifestIncompatibleCodecsError',
    }))
    expect(view.getByRole('alert')).toHaveTextContent(unplayableMessage)
  })

  it('gives up when the clock advances but no video frames are displayed', async () => {
    // Fake timers must exist before mount so the watchdog interval is theirs.
    vi.useFakeTimers()
    try {
      const videoRef = createRef<HTMLVideoElement>()
      const view = render(
        <Player room={room} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
      )
      const video = videoRef.current!
      let clock = 0
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock, set: () => undefined })
      Object.defineProperty(video, 'paused', { configurable: true, value: false })
      Object.defineProperty(video, 'getVideoPlaybackQuality', {
        configurable: true,
        value: () => ({ totalVideoFrames: 0 }),
      })

      await act(async () => {
        for (let tick = 0; tick < 8; tick += 1) {
          clock += 1
          await vi.advanceTimersByTimeAsync(1000)
        }
      })

      expect(view.getByRole('alert')).toHaveTextContent(unplayableMessage)
      expect(console.error).toHaveBeenCalledWith('[ss-player]', expect.stringContaining('no new video frames'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not condemn a platform that renders without reporting a frame count', async () => {
    vi.useFakeTimers()
    try {
      const videoRef = createRef<HTMLVideoElement>()
      const view = render(
        <Player room={room} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
      )
      const video = videoRef.current!
      let clock = 0
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock, set: () => undefined })
      Object.defineProperty(video, 'paused', { configurable: true, value: false })
      Object.defineProperty(video, 'getVideoPlaybackQuality', {
        configurable: true,
        value: () => ({ totalVideoFrames: 0 }),
      })
      // Some hardware overlay paths report zero for the life of a video that
      // is displaying perfectly. Real dimensions are the proof it is there.
      Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })

      await act(async () => {
        for (let tick = 0; tick < 12; tick += 1) {
          clock += 1
          await vi.advanceTimersByTimeAsync(1000)
        }
      })

      expect(view.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads in place and resumes when the media version moves, restarts on a new generation', async () => {
    const { videoRef, view, hls } = await renderPlayer()
    expect(hls.instances[0].loadedSource).toContain('g=3&v=0')
    videoRef.current!.currentTime = 42

    view.rerender(
      <Player room={{ ...room, mediaVersion: 1 }} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    await waitFor(() => expect(hls.instances.length).toBe(2))
    expect(hls.instances[0].destroyed).toBe(true)
    expect(hls.instances[1].loadedSource).toContain('g=3&v=1')
    // Same recording republished: the viewer keeps their place.
    expect(hls.instances[1].config.startPosition).toBe(42)

    view.rerender(
      <Player room={{ ...room, mediaGeneration: 4, mediaVersion: 1 }} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    await waitFor(() => expect(hls.instances.length).toBe(3))
    // A different recording starts at its beginning.
    expect(hls.instances[2].config.startPosition).toBe(0)
    expect(hls.instances[2].loadedSource).toContain('g=4&v=1')
  })

  it('refetches grown subtitle files and keeps the viewer selection', async () => {
    const subtitleTracks = [{ index: 0, language: 'en', title: 'English', codec: 'webvtt' }]
    const { videoRef, view } = await renderPlayer({ subtitleTracks, subsVersion: 1 })
    const video = videoRef.current!
    const textTracks = [{ mode: 'disabled' }]
    Object.defineProperty(video, 'textTracks', { configurable: true, value: textTracks })

    fireEvent.click(screen.getByRole('button', { name: /settings|configurações/i }))
    fireEvent.click(await screen.findByRole('button', { name: /subtitles|legendas/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'English' }))
    expect(textTracks[0].mode).toBe('showing')
    expect(view.container.querySelector('track')?.getAttribute('src')).toContain('&s=1')

    // The extraction publishing more cues bumps the version: the URL must
    // change so the browser refetches, and the selection must survive it.
    view.rerender(
      <Player room={{ ...room, subtitleTracks, subsVersion: 2 }} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    expect(view.container.querySelector('track')?.getAttribute('src')).toContain('&s=2')
    expect(textTracks[0].mode).toBe('showing')
  })

  it('replaces the track element when the subtitles grow, so the browser reloads the cues', async () => {
    const subtitleTracks = [{ index: 0, language: 'en', title: 'English', codec: 'webvtt' }]
    const { videoRef, view } = await renderPlayer({ subtitleTracks, subsVersion: 1 })
    const before = view.container.querySelector('track')

    // Browsers do not reliably refetch a <track> whose src attribute merely
    // changed: the cue list loaded first stays. Only a fresh element makes the
    // new version's cues reach a viewer who joined while extraction ran.
    view.rerender(
      <Player room={{ ...room, subtitleTracks, subsVersion: 2 }} isController={false} videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    const after = view.container.querySelector('track')
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
  })
})
