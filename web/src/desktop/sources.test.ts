import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDesktopForTests } from '../platform'
import { desktopYoutubeBackend, openDesktopTorrent } from './sources'
import { localMediaFor, resetLocalRoomsForTests } from './localRoom'

const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Filme'
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (cmd: string) => {
    switch (cmd) {
      case 'app_hello': return { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }
      case 'torrent_open': return {
        id: '0123456789abcdef0123456789abcdef01234567',
        name: 'Filme',
        files: [
          { index: 0, path: 'Filme/sample.txt', size: 10 },
          { index: 1, path: 'Filme/Filme.mkv', size: 1_000_000 },
          { index: 2, path: 'Filme/Filme.pt.srt', size: 2_000 },
        ],
      }
      case 'torrent_stats': return { peers: 3, downBps: 100, downloaded: 50, progress: 0.5 }
      case 'youtube_resolve': return { videoId: 'dQw4w9WgXcQ', title: 'Vídeo', durationMs: 212000, thumbnail: null, video: { itag: '1', codec: 'avc1', width: 1, height: 1 }, audios: [], subtitles: [], chapters: 0 }
      case 'local_prepare': return { key: 'k', title: 't', durationMs: 1 }
      case 'local_regions': return []
      default: return null
    }
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  resetDesktopForTests()
})

afterEach(() => {
  resetLocalRoomsForTests()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetDesktopForTests()
})

describe('desktop sources', () => {
  it('opens a magnet in the app with its videos and side subtitles', async () => {
    const session = await openDesktopTorrent(magnet)
    expect(invoke).toHaveBeenCalledWith('torrent_open', { magnet })
    expect(session.backend).toBe('desktop')
    expect(session.files.map((f) => f.name)).toEqual(['Filme.mkv'])
    expect(session.subtitleFiles.map((f) => f.name)).toEqual(['Filme.pt.srt'])
  })

  it('a picked file is selected in the app and its room plays from the cache', async () => {
    const session = await openDesktopTorrent(magnet)
    await session.select('Filme/Filme.mkv')
    expect(invoke).toHaveBeenCalledWith('torrent_select', { id: '0123456789abcdef0123456789abcdef01234567', index: 1 })
    expect(await session.startRemux!(session.files[0], { roomId: 'R', mediaGeneration: 2 })).toBeNull()
    expect(invoke).toHaveBeenCalledWith('local_prepare', { source: { kind: 'torrent', id: '0123456789abcdef0123456789abcdef01234567', index: 1, title: 'Filme.mkv' } })
    expect(localMediaFor('R')?.generation).toBe(2)
  })

  it('resolves and prepares a YouTube link in the app', async () => {
    const session = await desktopYoutubeBackend.resolve('https://youtu.be/dQw4w9WgXcQ')
    expect(session.backend).toBe('desktop')
    expect(session.summary.durationMs).toBe(212000)
    expect(await desktopYoutubeBackend.start(session, { roomId: 'R', mediaGeneration: 3 })).toBeNull()
    expect(invoke).toHaveBeenCalledWith('local_prepare', { source: { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', title: 'Vídeo' } })
  })

  it('YouTube in the app is available only with its tools', async () => {
    expect(await desktopYoutubeBackend.capacity()).toBe('available')
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    resetDesktopForTests()
    expect(await desktopYoutubeBackend.capacity()).toBe('disabled')
  })
})
