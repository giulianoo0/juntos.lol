import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  YoutubeError, canonicalYoutubeUrl, fleetBackend, openYoutube, registerYoutubeBackend, youtubeBackends,
  youtubeErrorKey, youtubeErrorRetryable, youtubeVideoId, type YoutubeBackend, type YoutubeSession,
} from './youtube'

describe('youtubeVideoId', () => {
  it('reads the id off every shape people paste', () => {
    for (const raw of [
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'youtube.com/watch?v=aqz-KE-bpKQ&t=10s',
      'https://youtu.be/aqz-KE-bpKQ?si=x',
      'https://m.youtube.com/watch?v=aqz-KE-bpKQ',
      'https://music.youtube.com/watch?v=aqz-KE-bpKQ&list=x',
      'https://www.youtube.com/shorts/aqz-KE-bpKQ',
      'https://www.youtube.com/live/aqz-KE-bpKQ?feature=share',
      'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
    ]) expect(youtubeVideoId(raw), raw).toBe('aqz-KE-bpKQ')
  })

  it('refuses what is not one video', () => {
    for (const raw of [
      '', 'magnet:?xt=urn:btih:abc', 'https://vimeo.com/1', 'https://www.youtube.com/playlist?list=PL1',
      'https://www.youtube.com/watch?v=short', 'https://notyoutube.com/watch?v=aqz-KE-bpKQ',
    ]) expect(youtubeVideoId(raw), raw).toBeNull()
  })

  it('canonicalizes to the watch url', () => {
    expect(canonicalYoutubeUrl('aqz-KE-bpKQ')).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  })
})

describe('youtube errors', () => {
  it('maps codes to copy and says which are final', () => {
    expect(youtubeErrorKey(new YoutubeError('youtube_blocked'))).toBe('home.youtubeBlocked')
    expect(youtubeErrorKey(new YoutubeError('quota'))).toBe('home.youtubeQuota')
    expect(youtubeErrorKey(new Error('x'))).toBe('home.youtubeFailed')
    expect(youtubeErrorRetryable(new YoutubeError('youtube_unavailable'))).toBe(false)
    expect(youtubeErrorRetryable(new YoutubeError('busy'))).toBe(true)
  })
})

function session(backend: 'fleet' | 'jlocal'): YoutubeSession {
  return {
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoId: 'aqz-KE-bpKQ', backend, destroy: () => undefined,
    summary: { videoId: 'aqz-KE-bpKQ', title: 't', durationMs: 1, thumbnail: null, video: { itag: '137', codec: 'h264', width: 1, height: 1 }, audios: [], subtitles: [], chapters: 0 },
  }
}

describe('openYoutube', () => {
  afterEach(() => {
    registerYoutubeBackend(fleetBackend)
    // Drop any test backend registered ahead of the fleet.
    for (const backend of youtubeBackends()) if (backend.name === 'jlocal') registerYoutubeBackend({ ...backend, capacity: async () => 'disabled' })
    vi.restoreAllMocks()
  })

  it('tries the companion app first and falls to the fleet when it has no room', async () => {
    const jlocal: YoutubeBackend = {
      name: 'jlocal', capacity: async () => 'no_workers', resolve: async () => { throw new Error('never') }, start: async () => null,
    }
    registerYoutubeBackend(jlocal)
    vi.spyOn(fleetBackend, 'capacity').mockResolvedValue('available')
    vi.spyOn(fleetBackend, 'resolve').mockResolvedValue(session('fleet'))
    const opened = await openYoutube('https://youtu.be/aqz-KE-bpKQ')
    expect(opened.backend).toBe('fleet')
  })

  it('stops at a verdict about the video itself', async () => {
    const jlocal: YoutubeBackend = {
      name: 'jlocal', capacity: async () => 'available', resolve: async () => { throw new YoutubeError('youtube_unavailable') }, start: async () => null,
    }
    registerYoutubeBackend(jlocal)
    const fleetResolve = vi.spyOn(fleetBackend, 'resolve')
    await expect(openYoutube('https://youtu.be/aqz-KE-bpKQ')).rejects.toMatchObject({ code: 'youtube_unavailable' })
    expect(fleetResolve).not.toHaveBeenCalled()
  })

  it('refuses a link that is not a video before asking anyone', async () => {
    await expect(openYoutube('https://vimeo.com/1')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('live error codes', () => {
  it('says the live ended and maps the fleet refusals', () => {
    expect(youtubeErrorKey(new YoutubeError('live_ended'))).toBe('room.liveEnded')
    expect(youtubeErrorKey(new YoutubeError('youtube_no_workers'))).toBe('home.youtubeNoWorkers')
    expect(youtubeErrorKey(new YoutubeError('youtube_busy'))).toBe('home.youtubeBusy')
  })
})
