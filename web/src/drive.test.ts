import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DriveAccessError,
  DriveError,
  DriveKeyMissingError,
  DriveQuotaError,
  DriveUnsupportedError,
  driveEntryForFile,
  driveMediaInput,
  driveMediaUrl,
  fetchDriveMeta,
  isDriveId,
  listDriveFolder,
  openDriveEntrySession,
  openDriveSession,
  parseDriveLink,
  probeDriveDownload,
} from './drive'

const VID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUq'
const FOL = '0BxiMVs0XRA5nFMdKvBdBZjgmUUq'
const DOC = '2CxiMVs0XRA5nFMdKvBdBZjgmUUq'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function meta(id: string, name: string, mimeType: string, size = '100'): Record<string, string> {
  return { id, name, mimeType, size }
}
let fetchMock: Mock

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_DRIVE_API_KEY', 'test-key')
  fetchMock = vi.fn(async () => json({}))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('parseDriveLink', () => {
  const cases: Array<[string, { kind: 'file' | 'folder'; id: string }]> = [
    [`https://drive.google.com/file/d/${VID}/view?usp=sharing`, { kind: 'file', id: VID }],
    [`https://drive.google.com/file/d/${VID}/edit`, { kind: 'file', id: VID }],
    [`https://drive.google.com/open?id=${VID}`, { kind: 'file', id: VID }],
    [`https://drive.google.com/uc?id=${VID}&export=download`, { kind: 'file', id: VID }],
    [`https://drive.google.com/drive/folders/${FOL}`, { kind: 'folder', id: FOL }],
    [`https://drive.google.com/drive/u/0/folders/${FOL}`, { kind: 'folder', id: FOL }],
    [`https://drive.google.com/u/1/file/d/${VID}/view`, { kind: 'file', id: VID }],
    [`https://docs.google.com/document/d/${DOC}/edit`, { kind: 'file', id: DOC }],
    [`https://docs.google.com/document/u/0/d/${DOC}/edit`, { kind: 'file', id: DOC }],
    [`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`, { kind: 'file', id: DOC }],
    [`https://docs.google.com/presentation/d/${DOC}/edit`, { kind: 'file', id: DOC }],
    [`http://drive.google.com/file/d/${VID}/view`, { kind: 'file', id: VID }],
    [VID, { kind: 'file', id: VID }],
  ]
  for (const [url, expected] of cases) {
    it(`parses ${url.slice(0, 48)}…`, () => {
      expect(parseDriveLink(url)).toEqual(expected)
    })
  }

  const garbage = [
    '',
    '   ',
    'not a link',
    'https://example.com/watch?v=abc',
    'https://drive.google.com/',
    'https://drive.google.com/file/d/short/view',
    'https://drive.google.com/open?id=short',
    'https://drive.google.com/drive/folders/too-short',
    'ftp://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUq/view',
  ]
  for (const url of garbage) {
    it(`rejects ${url.slice(0, 48) || '(empty)'}`, () => {
      expect(parseDriveLink(url)).toBeNull()
    })
  }
})

describe('isDriveId', () => {
  it('accepts long token IDs and rejects the rest', () => {
    expect(isDriveId(VID)).toBe(true)
    expect(isDriveId('short')).toBe(false)
    expect(isDriveId('')).toBe(false)
    expect(isDriveId('has space in it 123456789012345')).toBe(false)
  })
})

describe('missing key', () => {
  it('fails before any fetch when VITE_GOOGLE_DRIVE_API_KEY is unset', async () => {
    vi.stubEnv('VITE_GOOGLE_DRIVE_API_KEY', '')
    await expect(fetchDriveMeta(VID)).rejects.toBeInstanceOf(DriveKeyMissingError)
    await expect(listDriveFolder(FOL)).rejects.toBeInstanceOf(DriveKeyMissingError)
    expect(() => driveMediaUrl(VID)).toThrow(DriveKeyMissingError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bad IDs', () => {
  it('rejects without fetching', async () => {
    await expect(fetchDriveMeta('nope')).rejects.toMatchObject({ code: 'bad-id' })
    await expect(listDriveFolder('nope!')).rejects.toBeInstanceOf(DriveError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchDriveMeta', () => {
  it('returns typed metadata over the keyed API', async () => {
    fetchMock.mockResolvedValueOnce(json(meta(VID, 'movie.mkv', 'video/x-matroska', '1234')))
    const got = await fetchDriveMeta(VID)
    expect(got).toEqual({ id: VID, name: 'movie.mkv', mimeType: 'video/x-matroska', size: 1234 })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain(`www.googleapis.com/drive/v3/files/${VID}`)
    expect(url).toContain('key=test-key')
  })

  it('maps 404 to not-shared and quota reasons to quota', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'notFound' }] } }, 404))
    await expect(fetchDriveMeta(VID)).rejects.toBeInstanceOf(DriveAccessError)
    fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403))
    await expect(fetchDriveMeta(VID)).rejects.toBeInstanceOf(DriveQuotaError)
  })

  it('tells a spent download cap and a full Drive apart from plain rate limits', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }, 403))
    await expect(fetchDriveMeta(VID)).rejects.toMatchObject({ code: 'download-quota' })
    fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, 403))
    await expect(fetchDriveMeta(VID)).rejects.toMatchObject({ code: 'storage-full' })
  })

  it('rejects native Google docs with a clear error', async () => {
    fetchMock.mockResolvedValueOnce(json(meta(DOC, 'notes', 'application/vnd.google-apps.document')))
    await expect(fetchDriveMeta(DOC)).rejects.toBeInstanceOf(DriveUnsupportedError)
  })

  it('retries a 500 with backoff instead of failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(json(meta(VID, 'movie.mkv', 'video/mp4', '7')))
    const got = await fetchDriveMeta(VID)
    expect(got.size).toBe(7)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)
})

describe('listDriveFolder', () => {
  it('walks pages until the token runs out', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ files: [meta('a'.repeat(30), 'a.mkv', 'video/mp4', '1')], nextPageToken: 't1' }))
      .mockResolvedValueOnce(json({ files: [meta('b'.repeat(30), 'b.srt', 'text/plain', '2')] }))
    const entries = await listDriveFolder(FOL)
    expect(entries.map((e) => e.name)).toEqual(['a.mkv', 'b.srt'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops after 10 pages', async () => {
    fetchMock.mockImplementation(async () => json({ files: [], nextPageToken: 'more' }))
    const entries = await listDriveFolder(FOL)
    expect(entries).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })
})

describe('openDriveSession', () => {
  function route(url: string): Promise<Response> {
    if (url.includes('alt=media')) return Promise.resolve(new Response('bytes', { status: 206 }))
    if (url.includes('/drive/v3/files?')) {
      const decoded = decodeURIComponent(url)
      const parent = /'([^']+)' in parents/.exec(decoded)?.[1] ?? ''
      return Promise.resolve(json({ files: siblingsFor(parent) }))
    }
    const id = /\/drive\/v3\/files\/([^?]+)/.exec(url)?.[1] ?? ''
    return Promise.resolve(json(fileFor(id)))
  }

  const PARENT = 'p'.repeat(30)
  function fileFor(id: string): Record<string, unknown> {
    if (id === VID) {
      return { ...meta(VID, 'movie.mkv', 'video/x-matroska', '1000'), parents: [PARENT] }
    }
    return { id, name: 'Root', mimeType: FOLDER_MIME }
  }
  function siblingsFor(parent: string): Array<Record<string, string>> {
    if (parent !== PARENT) return []
    return [
      meta(VID, 'movie.mkv', 'video/x-matroska', '1000'),
      meta('s'.repeat(30), 'movie.srt', 'text/plain', '50'),
      meta('v'.repeat(30), 'movie.vtt', 'text/plain', '60'),
      meta('x'.repeat(30), 'notes.txt', 'text/plain', '10'),
      meta('g'.repeat(30), 'huge.srt', 'text/plain', String(9 * 1024 * 1024)),
    ]
  }

  it('opens a file link with same-folder subtitle sidecars', async () => {
    fetchMock.mockImplementation(route)
    const session = await openDriveSession({ kind: 'file', id: VID })
    expect(session.name).toBe('movie.mkv')
    expect(session.files.map((f) => f.name)).toEqual(['movie.mkv'])
    expect(session.subtitleFiles.map((f) => f.name).sort()).toEqual(['movie.srt', 'movie.vtt'])
    expect(session.stats()).toMatchObject({ progress: 1 })
    await session.select('movie.mkv')
    await expect(session.select('missing.mkv')).rejects.toThrow('drive file not found')
    expect(driveEntryForFile(session, 'movie.mkv')?.id).toBe(VID)
    expect(driveEntryForFile(session, 'movie.srt')?.name).toBe('movie.srt')
    // Metadata already carries parents, so opening needs only metadata plus
    // one sibling listing (the old path fetched parents a second time).
    expect(fetchMock).toHaveBeenCalledTimes(2)
    session.destroy()
  })

  it('builds a picked-entry session without another Drive request', () => {
    const session = openDriveEntrySession(
      { id: VID, name: 'movie.mkv', mimeType: 'video/x-matroska', size: 1000 },
      [{ id: 's'.repeat(30), name: 'movie.srt', mimeType: 'text/plain', size: 50 }],
    )
    expect(session.files.map((file) => file.name)).toEqual(['movie.mkv'])
    expect(session.subtitleFiles.map((file) => file.name)).toEqual(['movie.srt'])
    expect(fetchMock).not.toHaveBeenCalled()
    session.destroy()
  })

  it('collects a folder tree but never walks past depth 10', async () => {
    const chain = (d: number): string => `F${String(d).padStart(29, '0')}`
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url)
      if (target.includes('/drive/v3/files?')) {
        const parent = /'([^']+)' in parents/.exec(decodeURIComponent(target))?.[1] ?? ''
        if (parent === FOL) {
          return json({ files: [meta('q'.repeat(30), 'shallow.mp4', 'video/mp4', '5'), { ...meta(chain(1), 'f1', FOLDER_MIME), size: '0' }] })
        }
        const depth = Number(parent.slice(1))
        if (depth >= 1 && depth <= 10) {
          const files: Array<Record<string, string>> = depth < 10
            ? [{ ...meta(chain(depth + 1), `f${depth + 1}`, FOLDER_MIME), size: '0' }]
            : [meta('z'.repeat(30), 'deep.mkv', 'video/mp4', '9')]
          return json({ files })
        }
        throw new Error(`walked too deep: listed ${parent}`)
      }
      return json({ id: FOL, name: 'Root', mimeType: FOLDER_MIME })
    })
    const session = await openDriveSession({ kind: 'folder', id: FOL })
    expect(session.files.map((f) => f.name)).toEqual(['deep.mkv', 'shallow.mp4'])
    // A video nested one level deeper must stay unseen: its folder is never listed.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(13)
    session.destroy()
  })
  it('fails loud on folder trees past 5000 entries', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url)
      if (target.includes('/drive/v3/files?')) {
        const page = Number(/pageToken=page(\d+)/.exec(target)?.[1] ?? 0)
        const files = Array.from({ length: 1000 }, (_, i) =>
          meta(`e${String(page * 1000 + i).padStart(29, '0')}`, `clip${page * 1000 + i}.mp4`, 'video/mp4', '7'))
        return json({ files, ...(page < 5 ? { nextPageToken: `page${page + 1}` } : {}) })
      }
      return json({ id: FOL, name: 'Root', mimeType: FOLDER_MIME })
    })
    await expect(openDriveSession({ kind: 'folder', id: FOL })).rejects.toMatchObject({ code: 'too-many' })
  })
})

describe('driveErrorKey', () => {
  it('maps the tree cap to drive.tooMany', async () => {
    const { driveErrorKey } = await import('./driveErrors')
    expect(driveErrorKey({ code: 'too-many' })).toBe('drive.tooMany')
  })
})

describe('driveMediaInput', () => {
  it('reads bytes with a Range GET and retries a 5xx', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const seen: Array<{ url: string; range: string }> = []
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(url), range: headers.get('Range') ?? '' })
      if (seen.length === 1) return new Response('boom', { status: 500 })
      const bytes = new Uint8Array([104, 105])
      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes); c.close() },
      })
      return new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } })
    })
    const input = driveMediaInput({ id: VID, name: 'movie.mkv', mimeType: 'video/mp4', size: 2 })
    expect(await input.read(0, 2)).toEqual(new Uint8Array([104, 105]))
    expect(seen[1].url).toContain('alt=media')
    expect(seen[1].url).toContain('key=test-key')
    expect(seen[1].range).toBe('bytes=0-1')
    input.dispose()
  }, 10_000)

  it('builds the keyed media URL', () => {
    expect(driveMediaUrl(VID)).toContain(`www.googleapis.com/drive/v3/files/${VID}?alt=media&key=test-key`)
  })
})

describe('probeDriveDownload', () => {
  it('passes on a partial read and names the refusal otherwise', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 206, body: null, json: async () => null } as unknown as Response)
    await expect(probeDriveDownload(VID)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Range: 'bytes=0-0' } })
    fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }, 403))
    await expect(probeDriveDownload(VID)).rejects.toMatchObject({ code: 'download-quota' })
  })
})
