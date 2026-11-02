import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebKit, screenShareSupported } from './screenshare'
import { appCanCapture } from './desktop/screen'

vi.mock('./desktop/screen', () => ({ appCanCapture: vi.fn(() => false) }))

describe('isWebKit', () => {
  it('names Safari on the Mac and every browser on iOS', () => {
    expect(isWebKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15')).toBe(true)
    expect(isWebKit('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1')).toBe(true)
    expect(isWebKit('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1')).toBe(true)
  })

  it('leaves Chromium and Firefox alone', () => {
    expect(isWebKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36')).toBe(false)
    expect(isWebKit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0')).toBe(false)
    expect(isWebKit('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36')).toBe(false)
    expect(isWebKit('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0')).toBe(false)
  })
})

describe('screenShareSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(appCanCapture).mockReturnValue(false)
  })
  const WKWEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const webkit = () => {
    vi.stubGlobal('navigator', { userAgent: WKWEBVIEW })
    vi.stubGlobal('WebTransport', class {})
    vi.stubGlobal('VideoEncoder', class {})
    vi.stubGlobal('VideoDecoder', class {})
  }

  it('offers the screen in the Mac app, which captures and encodes it itself', () => {
    webkit()
    vi.mocked(appCanCapture).mockReturnValue(true)
    expect(screenShareSupported()).toBe(true)
  })

  it('keeps Safari itself from sending a screen', () => {
    webkit()
    expect(screenShareSupported()).toBe(false)
  })
})
