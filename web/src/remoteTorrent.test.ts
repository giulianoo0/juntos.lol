import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMagnet, probeWorkers } from './remoteTorrent'

describe('parseMagnet', () => {
  it('reads a hex hash, trackers and the name', () => {
    const parsed = parseMagnet('magnet:?xt=urn:btih:' + 'AB'.repeat(20) + '&dn=Some+Show&tr=udp%3A%2F%2Fa%3A1&tr=udp%3A%2F%2Fb%3A2')
    expect(parsed).toEqual({ infoHash: 'ab'.repeat(20), trackers: ['udp://a:1', 'udp://b:2'], dn: 'Some Show' })
  })

  it('converts a base32 hash', () => {
    // 20 bytes of 0x00..0x13, base32.
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i)
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const b of bytes) bits += b.toString(2).padStart(8, '0')
    let b32 = ''
    for (let i = 0; i < bits.length; i += 5) b32 += alphabet[parseInt(bits.slice(i, i + 5), 2)]
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32}`)?.infoHash).toBe(hex)
  })

  it('rejects what is not a magnet with a hash', () => {
    expect(parseMagnet('https://example.com/file.torrent')).toBeNull()
    expect(parseMagnet('magnet:?xt=urn:btih:short')).toBeNull()
    expect(parseMagnet('magnet:?dn=only-a-name')).toBeNull()
  })
})

describe('probeWorkers, on the way into a room', () => {
  const workers = [
    { id: 'a', readBase: 'https://a.example', holds: false, probe: 'https://a.example/probe' },
    { id: 'b', readBase: 'https://b.example', holds: false, probe: 'https://b.example/probe' },
  ]

  const probeBody = (bytes: number) => new ReadableStream<Uint8Array>({
    start(c) {
      for (let sent = 0; sent < bytes; sent += 64 * 1024) c.enqueue(new Uint8Array(64 * 1024))
      c.close()
    },
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/workers')) return new Response(JSON.stringify({ workers }))
      return new Response(probeBody(3 * 1024 * 1024), { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reuses a ranking it already paid for', async () => {
    const first = await probeWorkers('deadbeef01')
    expect(first.filter((p) => p.state === 'ok')).not.toHaveLength(0)
    const callsAfterFirst = vi.mocked(fetch).mock.calls.length

    const second = await probeWorkers('deadbeef01')
    expect(second).toEqual(first)
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirst)
  })

  it('measures again when the caller asks for it', async () => {
    await probeWorkers('deadbeef02')
    const callsAfterFirst = vi.mocked(fetch).mock.calls.length
    await probeWorkers('deadbeef02', undefined, { fresh: true })
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})
