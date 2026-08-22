import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToken, clientIdentifier, createPin, getToken, pollPin, setToken } from './account'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('clientIdentifier', () => {
  it('is stable across calls', async () => {
    const first = await clientIdentifier()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await clientIdentifier()).toBe(first)
  })
})

describe('createPin', () => {
  it('asks plex.tv for a pin and builds the url the person has to visit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, code: 'WXYZ' }, 201))
    const pin = await createPin({ fetch: fetchMock as unknown as typeof fetch })
    expect(pin).toMatchObject({ id: 42, code: 'WXYZ' })
    expect(pin.authUrl).toContain('app.plex.tv/auth')
    expect(pin.authUrl).toContain('code=WXYZ')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://plex.tv/api/v2/pins?strong=true')
    expect(init.method).toBe('POST')
    // Without this header plex.tv answers 400, and the failure reads as "the
    // pin endpoint is broken" rather than "you forgot a header".
    expect((init.headers as Record<string, string>)['X-Plex-Client-Identifier']).toBeTruthy()
    expect((init.headers as Record<string, string>).Accept).toBe('application/json')
  })

  it('fails rather than inventing a pin when the answer has none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}))
    await expect(createPin({ fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/no pin/)
  })
})

describe('pollPin', () => {
  it('answers null while the pin is still waiting for approval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, authToken: null }))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBeNull()
  })

  it('answers the token once it has been approved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, authToken: 'tok_abc' }))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBe('tok_abc')
  })

  it('treats an expired pin as an error, not as still waiting', async () => {
    // Polling for ever against something that will never answer is the failure
    // this prevents.
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'gone' }, 404))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/expired/i)
  })
})

describe('the token', () => {
  beforeEach(async () => { await clearToken() })

  it('is absent until one is stored', async () => {
    expect(await getToken()).toBeNull()
  })

  it('survives being written and read back', async () => {
    await setToken('tok_abc')
    expect(await getToken()).toBe('tok_abc')
  })

  it('can be forgotten, which is the whole point of having a disconnect button', async () => {
    await setToken('tok_abc')
    await clearToken()
    expect(await getToken()).toBeNull()
  })
})
