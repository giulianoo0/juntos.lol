import { describe, expect, it } from 'vitest'
import { appRoomLink } from './openInApp'

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const HREF = 'https://juntos.lol/room/ABCD1234'

describe('appRoomLink', () => {
  it("hands Android's Chrome an intent that falls back to this page marked web=1", () => {
    const link = appRoomLink('ABCD1234', HREF, CHROME_ANDROID, false)!
    expect(link.startsWith('intent://room/ABCD1234#Intent;scheme=juntos;package=lol.juntos.app;')).toBe(true)
    expect(decodeURIComponent(link.split('S.browser_fallback_url=')[1].replace(';end', ''))).toBe(`${HREF}?web=1`)
  })

  it('leaves the page alone once it came back with web=1, in a web view and on an iPhone', () => {
    expect(appRoomLink('ABCD1234', `${HREF}?web=1`, CHROME_ANDROID, true)).toBeNull()
    expect(appRoomLink('ABCD1234', HREF, ANDROID_WEBVIEW, true)).toBeNull()
    expect(appRoomLink('ABCD1234', HREF, IPHONE, true)).toBeNull()
  })

  it("always tries the desktop app's own link in Chrome and Edge, which ignore it when no app answers", () => {
    expect(appRoomLink('ABCD1234', HREF, WINDOWS_CHROME, false)).toBe('juntos://room/ABCD1234')
    expect(appRoomLink('ABCD1234', HREF, WINDOWS_EDGE, false)).toBe('juntos://room/ABCD1234')
  })

  it('tries it in Safari only once that browser downloaded the app', () => {
    expect(appRoomLink('ABCD1234', HREF, MAC_SAFARI, false)).toBeNull()
    expect(appRoomLink('ABCD1234', HREF, MAC_SAFARI, true)).toBe('juntos://room/ABCD1234')
  })

  it('never builds a link from a room id that is not one', () => {
    expect(appRoomLink('../x', HREF, MAC_SAFARI, true)).toBeNull()
  })
})
