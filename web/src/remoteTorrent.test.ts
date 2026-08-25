import { describe, expect, it } from 'vitest'
import { parseMagnet } from './remoteTorrent'

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
