import { describe, expect, it } from 'vitest'
import { bundledBody, initSegmentsIn, playlistNameOf, type PlaylistBundle } from './bundle'

const bundle: PlaylistBundle = {
  master: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nr2_client_stream_1.m3u8\n',
  playlists: {
    'r2_client_stream_1.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="https://media/rooms/x/g0/hls/r2_cinit_1.mp4"\n#EXTINF:4,\nhttps://media/rooms/x/g0/hls/r2_cs_1_1.m4s\n',
    'r2_client_stream_2.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="https://media/rooms/x/g0/hls/r2_cinit_2.mp4"\n#EXT-X-MAP:URI="https://media/rooms/x/g0/hls/r2_cinit_2.mp4"\n',
  },
}

describe('playlist bundle', () => {
  it('names a request by its path, not its query', () => {
    expect(playlistNameOf('/media/IM3/hls/r2_master.m3u8?g=0&v=0')).toBe('r2_master.m3u8')
    expect(playlistNameOf('https://juntos.lol/media/IM3/hls/r2_client_stream_1.m3u8')).toBe('r2_client_stream_1.m3u8')
  })
  it('answers the master and the bundled playlists, and nothing else', () => {
    expect(bundledBody(bundle, 'r2_master.m3u8')).toBe(bundle.master)
    expect(bundledBody(bundle, 'r2_client_stream_1.m3u8')).toContain('r2_cs_1_1.m4s')
    expect(bundledBody(bundle, 'r2_client_stream_9.m3u8')).toBeNull()
    expect(bundledBody(bundle, 'toString')).toBeNull()
    expect(bundledBody(null, 'r2_master.m3u8')).toBeNull()
  })
  it('lists each init segment once', () => {
    expect(initSegmentsIn(bundle)).toEqual([
      'https://media/rooms/x/g0/hls/r2_cinit_1.mp4',
      'https://media/rooms/x/g0/hls/r2_cinit_2.mp4',
    ])
    expect(initSegmentsIn(null)).toEqual([])
  })
})
