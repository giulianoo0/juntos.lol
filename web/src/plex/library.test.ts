import { describe, expect, it, vi } from 'vitest'
import { itemDetails, partUrl, searchLibrary } from './library'

const base = 'https://10-0-0-5.hash.plex.direct:32400'
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('searchLibrary', () => {
  it('reads titles out of a plex search response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      MediaContainer: {
        Metadata: [
          { ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' },
          { ratingKey: '12', title: 'Um artista', year: 2019, type: 'artist' },
        ],
      },
    }))
    const found = await searchLibrary(base, 'tok', 'duna', { fetch: fetchMock as unknown as typeof fetch })
    // Music and photos are on the same account and are not what a watch party
    // is for.
    expect(found.map((item) => item.title)).toEqual(['Duna'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('query=duna')
  })
})

describe('itemDetails', () => {
  it('finds the file behind a title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      MediaContainer: {
        Metadata: [{
          ratingKey: '11', title: 'Duna', year: 2021, type: 'movie',
          Media: [{ container: 'mkv', Part: [{ key: '/library/parts/9/1600/file.mkv', size: 1234567 }] }],
        }],
      },
    }))
    const item = await itemDetails(base, 'tok', '11', { fetch: fetchMock as unknown as typeof fetch })
    expect(item).toMatchObject({
      title: 'Duna', partKey: '/library/parts/9/1600/file.mkv', size: 1234567, container: 'mkv',
    })
  })

  it('is explicit when the title has no file behind it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ MediaContainer: { Metadata: [{ ratingKey: '11', title: 'Duna' }] } }))
    await expect(itemDetails(base, 'tok', '11', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/no playable file/i)
  })
})

describe('partUrl', () => {
  it('builds a url the browser can range-request', () => {
    expect(partUrl(base, '/library/parts/9/1600/file.mkv', 'tok'))
      .toBe(`${base}/library/parts/9/1600/file.mkv?download=1&X-Plex-Token=tok`)
  })
})
