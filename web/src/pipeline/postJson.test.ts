import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postJson } from './postJson'

const nosleep = () => Promise.resolve()

describe('postJson', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.restoreAllMocks())

  it('waits out a server that blinked and carries on', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const response = await postJson('/publish', { a: 1 }, { sleep: nosleep })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a dropped connection too', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    expect((await postJson('/publish', {}, { sleep: nosleep })).status).toBe(200)
  })

  it('returns a refusal the server meant at once', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"claim_mismatch"}', { status: 409 }))
    const response = await postJson('/publish', {}, { sleep: nosleep })
    expect(response.status).toBe(409)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up eventually, reporting what actually happened', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }))
    const response = await postJson('/publish', {}, { attempts: 3, sleep: nosleep })
    expect(response.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops when the run is aborted', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(() => { controller.abort(); return Promise.resolve(new Response(null, { status: 502 })) })
    const response = await postJson('/publish', {}, { signal: controller.signal, sleep: nosleep })
    expect(response.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
