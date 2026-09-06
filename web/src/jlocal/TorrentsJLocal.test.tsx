import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TorrentPicker } from '../components/TorrentPicker'
import { JLocalScreenModal } from '../components/JLocalScreen'
import { translate, type Translator } from '../i18n/useT'
import { openTorrent } from '../torrent'
import {
  addMagnet,
  isJLocalTorrentAvailable,
  listJLocalTorrentFiles,
  parseJLocalTorrentAdded,
  torrentStreamUrl,
  type JLocalPickedStream,
} from './torrents'
import {
  getCachedJLocalCapabilities,
  refreshJLocalCapabilities,
  resetJLocalCapabilitiesForTests,
} from './capabilities'
import { JLOCAL_ORIGIN, connectJLocal, getJLocalSnapshot, resetJLocalForTests } from './status'
vi.mock('../torrent', () => ({ openTorrent: vi.fn() }))

const INFOHASH = 'ab'.repeat(20)
const MAGNET = 'magnet:?xt=urn:btih:ababababababababababababababababababababab'

const CAPS_TORRENT = {
  name: 'jlocal',
  version: 'v0.0.1',
  capabilities: {
    screen: { available: false, capture: false, maxWidth: 1920, maxHeight: 1080, maxFps: 30 },
    audio: { appList: false },
    torrent: { available: true },
  },
}

const CAPS_SCREEN = {
  name: 'jlocal',
  version: 'v0.0.1',
  capabilities: {
    screen: { available: true, capture: true, maxWidth: 3840, maxHeight: 2160, maxFps: 60 },
    audio: { appList: false },
    torrent: { available: false },
  },
}

/** Routes /health to the status probe and /capabilities to the caps fetch; jlocal torrent endpoints answer from overrides. */
function stubFetch(health: unknown, caps: unknown, overrides: Record<string, unknown> = {}, capsOk = true): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const target = String(url)
    if (target.endsWith('/capabilities')) {
      return { ok: capsOk, status: capsOk ? 200 : 501, json: async () => caps }
    }
    if (target.endsWith('/torrent/add')) {
      return { ok: true, status: 200, json: async () => overrides.add ?? { id: INFOHASH, name: 'Big Buck Bunny' } }
    }
    if (target.endsWith('/torrent/list')) {
      return {
        ok: true,
        status: 200,
        json: async () => overrides.list ?? {
          torrents: [{
            id: INFOHASH,
            name: 'Big Buck Bunny',
            size: 3000,
            progress: 1,
            state: 'seeding',
            downBps: 0,
            files: [
              { index: 0, path: 'Big Buck Bunny/bunny.mkv', size: 2000 },
              { index: 1, path: 'Big Buck Bunny/poster.jpg', size: 1000 },
            ],
          }],
        },
      }
    }
    if (target.endsWith('/torrent/select')) {
      return { ok: true, status: 200, json: async () => ({}) }
    }
    if (target.endsWith('/api/torrents/capacity')) {
      return { ok: true, status: 200, json: async () => ({ capacity: 'available' }) }
    }
    void init
    return { ok: true, json: async () => health }
  }))
}

async function connectWithCaps(caps: unknown): Promise<void> {
  stubFetch({ name: 'jlocal', version: 'v0.0.1' }, caps)
  connectJLocal()
  await waitFor(() => expect(getJLocalSnapshot().connected).toBe(true))
  refreshJLocalCapabilities()
  await waitFor(() => expect(getCachedJLocalCapabilities()).not.toBeNull())
}

function enTranslator(): Translator {
  const t = ((key: string) => translate('en', key)) as Translator
  t.language = 'en'
  t.setLanguage = () => undefined
  return t
}

describe('jlocal torrent gate', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('returns false while the app is disconnected', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    expect(getJLocalSnapshot().connected).toBe(false)
    expect(isJLocalTorrentAvailable()).toBe(false)
  })

  it('returns false when connected but the app does not advertise torrents', async () => {
    await connectWithCaps(CAPS_SCREEN)
    expect(getCachedJLocalCapabilities()?.torrent.available).toBe(false)
    expect(isJLocalTorrentAvailable()).toBe(false)
  })

  it('returns true when connected with cached caps advertising torrents', async () => {
    await connectWithCaps(CAPS_TORRENT)
    expect(isJLocalTorrentAvailable()).toBe(true)
  })
})

describe('jlocal torrent parsers', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('addMagnet posts the magnet and parses the answer', async () => {
    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, CAPS_TORRENT)
    const seen: { url?: string; init?: { method?: string; body?: string } } = {}
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      seen.url = String(url)
      seen.init = init
      return { ok: true, status: 200, json: async () => ({ id: INFOHASH, name: 'Big Buck Bunny' }) }
    }))
    const added = await addMagnet(new AbortController().signal, MAGNET)
    expect(added).toEqual({ id: INFOHASH, name: 'Big Buck Bunny' })
    expect(seen.url).toBe(`${JLOCAL_ORIGIN}/torrent/add`)
    expect(seen.init?.method).toBe('POST')
    expect(JSON.parse(seen.init?.body ?? '{}')).toEqual({ magnet: MAGNET })
  })

  it('rejects non-jlocal bodies like room JSON', async () => {
    // A room creation answers {id, nickname}: no 40-hex infohash, no name.
    expect(parseJLocalTorrentAdded({ id: 'room1234', nickname: 'giuli' })).toBeNull()
    expect(parseJLocalTorrentAdded({ error: 'not_implemented' })).toBeNull()
    expect(parseJLocalTorrentAdded({ id: 'room1234', name: 'x' })).toBeNull()
    expect(parseJLocalTorrentAdded({ id: INFOHASH })).toBeNull()
    expect(parseJLocalTorrentAdded(null)).toBeNull()
    expect(parseJLocalTorrentAdded([])).toBeNull()

    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, CAPS_TORRENT, {
      add: { id: 'room1234', nickname: 'giuli' },
      list: { id: 'room1234', nickname: 'giuli' },
    })
    const controller = new AbortController()
    expect(await addMagnet(controller.signal, MAGNET)).toBeNull()
    expect(await listJLocalTorrentFiles(controller.signal, INFOHASH)).toBeNull()
  })

  it('builds loopback stream urls', () => {
    expect(torrentStreamUrl(INFOHASH, 0)).toBe(`${JLOCAL_ORIGIN}/torrent/data/${INFOHASH}/0`)
    expect(torrentStreamUrl(INFOHASH, 'show/ep 01.mkv')).toBe(
      `${JLOCAL_ORIGIN}/torrent/data/${INFOHASH}/${encodeURIComponent('show/ep 01.mkv')}`,
    )
  })
})

describe('jlocal torrent picker', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
    vi.mocked(openTorrent).mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lists app files with a local badge and hands a stream url to the room flow', async () => {
    await connectWithCaps(CAPS_TORRENT)
    const picked: JLocalPickedStream[] = []
    render(
      <TorrentPicker
        maxFileBytes={50_000}
        t={enTranslator()}
        onPicked={() => { throw new Error('native path must not run') }}
        onPickedJLocal={(stream) => { picked.push(stream) }}
      />,
    )
    fireEvent.change(screen.getByLabelText(/magnet link/i), { target: { value: MAGNET } })
    fireEvent.click(screen.getByRole('button', { name: /find files/i }))

    expect(await screen.findByText('Local via JLocal')).toBeInTheDocument()
    expect(screen.getByTitle(/straight from the app/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /bunny\.mkv/i }))

    await waitFor(() => expect(picked).toHaveLength(1))
    expect(picked[0]).toEqual({
      url: `${JLOCAL_ORIGIN}/torrent/data/${INFOHASH}/0`,
      name: 'bunny.mkv',
      size: 2000,
      torrentId: INFOHASH,
      torrentName: 'Big Buck Bunny',
    })
  })

  it('falls back to the native path when the app refuses the magnet', async () => {
    await connectWithCaps(CAPS_TORRENT)
    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, CAPS_TORRENT, {
      add: { error: 'not_implemented' },
    })
    vi.mocked(openTorrent).mockResolvedValue({
      name: 'Native',
      files: [],
      subtitleFiles: [],
      stats: () => ({ peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }),
      select: vi.fn(),
      destroy: vi.fn(),
    })
    render(
      <TorrentPicker
        maxFileBytes={50_000}
        t={enTranslator()}
        onPicked={() => undefined}
        onPickedJLocal={() => { throw new Error('jlocal path must not run') }}
      />,
    )
    fireEvent.change(screen.getByLabelText(/magnet link/i), { target: { value: MAGNET } })
    fireEvent.click(screen.getByRole('button', { name: /find files/i }))
    await waitFor(() => expect(vi.mocked(openTorrent)).toHaveBeenCalled())
  })
})

describe('jlocal capture preview', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows a shimmering snapshot pane once a display is picked', async () => {
    await connectWithCaps(CAPS_SCREEN)
    // Displays resolve (first is auto-selected); frames preload offscreen and
    // nothing ever lands under jsdom, so the pane holds its shimmer.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/capture/displays')) {
        return {
          ok: true,
          json: async () => ({ displays: [{ id: 1, name: 'Main', width: 1512, height: 982 }] }),
        }
      }
      throw new Error('refused')
    }))
    // The dialog renders in a Radix portal on document.body, not in the
    // render container: query document-wide like screen.* does.
    render(
      <JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} onConfirm={() => undefined} />,
    )
    await screen.findByRole('radio', { name: /Main/ })
    expect(document.querySelector('.jscreen-preview')).toBeNull()
    expect(document.querySelector('.jscreen-preview-shimmer')).not.toBeNull()
  })

  it('renders no preview when capture is not advertised', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    render(
      <JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} onConfirm={() => undefined} />,
    )
    expect(document.querySelector('.jscreen-dialog img')).toBeNull()
  })
})
