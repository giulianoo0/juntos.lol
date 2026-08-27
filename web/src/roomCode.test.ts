import { describe, expect, it } from 'vitest'
import { roomCodeFrom } from './roomCode'

// What people actually paste: the link as sent, the link after a chat client
// has eaten the scheme, and the code alone read off someone's screen.
describe('roomCodeFrom', () => {
  it('reads the code out of a full room link', () => {
    expect(roomCodeFrom('https://juntos.lol/room/ABCD1234')).toBe('ABCD1234')
  })

  it('reads it without a scheme, and with a trailing slash', () => {
    expect(roomCodeFrom('juntos.lol/room/ABCD1234')).toBe('ABCD1234')
    expect(roomCodeFrom('https://juntos.lol/room/ABCD1234/')).toBe('ABCD1234')
  })

  it('takes the bare code, in any case, with stray spaces', () => {
    expect(roomCodeFrom('  abcd1234 ')).toBe('ABCD1234')
    expect(roomCodeFrom('AbCd1234')).toBe('ABCD1234')
  })

  it('ignores a tracking parameter or a fragment the link picked up', () => {
    expect(roomCodeFrom('https://juntos.lol/room/ABCD1234?utm_source=x')).toBe('ABCD1234')
    expect(roomCodeFrom('https://juntos.lol/room/ABCD1234#top')).toBe('ABCD1234')
  })

  it('refuses anything that is not a room code', () => {
    for (const bad of ['', '   ', 'ABCD123', 'ABCD12345', 'ABCD-123', 'https://juntos.lol/', 'hello there']) {
      expect(roomCodeFrom(bad)).toBeNull()
    }
  })
})
