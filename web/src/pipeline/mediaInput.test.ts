import { afterEach, describe, expect, it, vi } from 'vitest'
import { rangeInput } from './mediaInput'

afterEach(() => { vi.unstubAllGlobals() })

function serve() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Range': 'bytes 0-3/10' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('rangeInput', () => {
  it('a url de uma extensão sai intacta, sem prio, e não segue redirecionamento', async () => {
    const fetch = serve()
    const url = 'https://a.cdn.example/v.mp4?policy=p&signature=s'

    await rangeInput(url, 'Emma', 10, { external: true }).read(0, 4, { prio: 'playhead' })

    expect(String(fetch.mock.calls[0][0])).toBe(url)
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error')
  })

  it('as demais urls levam o prio da leitura', async () => {
    const fetch = serve()

    await rangeInput('https://worker.example/r/v.mp4', 'Emma', 10).read(0, 4, { prio: 'playhead' })

    expect(String(fetch.mock.calls[0][0])).toContain('prio=playhead')
  })
})
