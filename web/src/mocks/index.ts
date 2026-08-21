import type { TorrentSession, TorrentStats, TorrentVideoFile } from '../torrent'
import type { RoomInfo } from '../types'
import type { UploadResult } from '../upload'

/**
 * Stand-ins for the two things the home flow cannot do on a laptop with no
 * server and no swarm: open a torrent, and create a room by uploading to one.
 *
 * Off unless asked for, and only in a dev build, so a production bundle never
 * carries a path that could hand someone a room that does not exist. Run it
 * with `npm run dev:mock`.
 */
export const mocksEnabled = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1'

/** Long enough that filtering the list is worth having. */
const MOCK_FILES: Array<{ name: string; size: number }> = [
  { name: 'Frieren.S01E01.Journeys.End.1080p.mkv', size: 1_412_000_000 },
  { name: 'Frieren.S01E02.It.Didnt.Have.To.Be.Magic.1080p.mkv', size: 1_388_400_000 },
  { name: 'Frieren.S01E03.Killer.of.Demons.1080p.mkv', size: 1_401_900_000 },
  { name: 'Frieren.S01E04.The.Land.Where.Souls.Rest.1080p.mkv', size: 1_366_300_000 },
  { name: 'Frieren.S01E05.Phantoms.of.the.Dead.1080p.mkv', size: 1_423_700_000 },
  { name: 'Frieren.S01E06.The.Hero.of.the.Village.1080p.mkv', size: 1_390_100_000 },
  { name: 'Frieren.S01E07.Like.a.Fairy.Tale.1080p.mkv', size: 1_377_800_000 },
  { name: 'Frieren.S01E08.Frieren.the.Slayer.1080p.mkv', size: 1_444_200_000 },
  { name: 'Frieren.S02E01.The.Land.of.Dreams.1080p.mkv', size: 1_509_600_000 },
  { name: 'Frieren.S02E02.A.Real.Hero.1080p.mkv', size: 1_487_300_000 },
  { name: 'Frieren.S02E03.Aura.the.Guillotine.1080p.mkv', size: 1_522_800_000 },
  { name: 'Frieren.OVA.Nach.dem.Ende.1080p.mkv', size: 980_500_000 },
  { name: 'Frieren.NCOP01.1080p.mkv', size: 96_400_000 },
  { name: 'Frieren.NCED01.1080p.mkv', size: 94_100_000 },
]

function mockVideoFile({ name, size }: { name: string; size: number }): TorrentVideoFile {
  return {
    name,
    path: `Frieren [Mock Release]/${name}`,
    size,
    type: 'video/x-matroska',
    progress: 0,
    downloaded: 0,
    read: () => Promise.resolve(new ArrayBuffer(0)),
  }
}

/** Climbs the way a real swarm does, so the picker's counters have something to show. */
function mockStats(startedAt: number): TorrentStats {
  const seconds = (performance.now() - startedAt) / 1000
  return {
    peers: Math.min(48, 3 + Math.floor(seconds * 4)),
    downloadSpeed: 2_400_000 + Math.round(Math.sin(seconds) * 900_000),
    downloaded: Math.round(seconds * 2_400_000),
    progress: Math.min(1, seconds / 600),
  }
}

const MOCK_METADATA_MS = 1_400

export function mockOpenTorrent(onStats?: (stats: TorrentStats) => void): Promise<TorrentSession> {
  const startedAt = performance.now()
  let ticker = 0
  return new Promise((resolve) => {
    // The wait is the point: it is what the button's loading state is for.
    window.setTimeout(() => {
      if (onStats) {
        ticker = window.setInterval(() => onStats(mockStats(startedAt)), 500)
        onStats(mockStats(startedAt))
      }
      resolve({
        name: 'Frieren [Mock Release] [1080p] [Multi-Sub]',
        files: MOCK_FILES.map(mockVideoFile),
        subtitleFiles: [],
        stats: () => mockStats(startedAt),
        select: () => Promise.resolve(),
        destroy: () => window.clearInterval(ticker),
      })
    }, MOCK_METADATA_MS)
  })
}

const MOCK_ROOM_ID = 'mockroom'

export function mockCreateRoom(nickname: string): Promise<UploadResult> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve({ roomID: MOCK_ROOM_ID, nickname: nickname || 'Guest-mock01' }), 600)
  })
}

/**
 * The dubs and renditions a mock room plays with.
 *
 * The real ones are reported by hls.js once it has attached to a playlist, and
 * there is no playlist here — so without these the settings panel has a single
 * group in it and most of what it does cannot be seen at all.
 */
export const MOCK_AUDIO_TRACKS = [
  { name: 'Japonês', lang: 'jpn' },
  { name: 'Português', lang: 'por' },
  { name: 'Inglês', lang: 'eng' },
]

export const MOCK_LEVELS = [
  { height: 480, bitrate: 1_200_000 },
  { height: 720, bitrate: 2_800_000 },
  { height: 1080, bitrate: 5_400_000 },
]

/** How long a mock room spends receiving its file before it becomes playable. */
const MOCK_PREPARE_MS = 12_000
const MOCK_SOURCE_BYTES = 1_487_300_000
const MOCK_TARGET_BYTES = Math.round(MOCK_SOURCE_BYTES * 0.06)

function mockRoom(id: string, elapsedMs: number): RoomInfo {
  const share = Math.min(1, elapsedMs / MOCK_PREPARE_MS)
  const received = Math.round(MOCK_SOURCE_BYTES * share * 0.35)
  const ready = elapsedMs >= MOCK_PREPARE_MS
  return {
    id,
    fileName: 'Frieren.S02E02.A.Real.Hero.1080p.mkv',
    status: ready ? 'ready' : 'uploading',
    sourceKind: 'upload',
    mediaGeneration: 0,
    controllerId: 'mock-member',
    audioTracks: [{ index: 0, language: 'jpn', title: 'Japanese', codec: 'aac' }],
    subtitleTracks: [{ index: 0, language: 'por', title: 'Português', codec: 'ass' }],
    bitmapSubsSkipped: 0,
    memberCount: 1,
    expiresAt: '2099-01-01T00:00:00Z',
    mediaBaseUrl: '/mock-media',
    preparation: ready ? undefined : {
      sourceBytes: MOCK_SOURCE_BYTES,
      receivedBytes: received,
      previewTargetBytes: MOCK_TARGET_BYTES,
      previewPhase: received >= MOCK_TARGET_BYTES ? 'segmenting' : 'receiving',
    },
  }
}

/**
 * Answers the room endpoint so the whole waiting flow can be walked without a
 * server: a room that arrives, spends {@link MOCK_PREPARE_MS} receiving its
 * file with the counters climbing, then turns playable.
 *
 * `/room/expired` is always gone, since that state is otherwise unreachable
 * here and is the one people most often need to look at.
 */
export function installMockApi() {
  if (!mocksEnabled) return
  const real = window.fetch.bind(window)
  const openedAt = performance.now()
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const room = /\/api\/rooms\/([^/?]+)$/.exec(url)
    if (!room) return real(input, init)
    const id = decodeURIComponent(room[1])
    if (id === 'expired') return new Response('room not found', { status: 404 })
    return new Response(JSON.stringify(mockRoom(id, performance.now() - openedAt)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
