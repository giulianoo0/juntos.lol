import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchConnection } from './moq'

const WKWEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

function fakeNet(webTransport: boolean) {
  const Reload = vi.fn(function Reload(this: { props: unknown }, props: unknown) { this.props = props })
  return { net: { Connection: { Reload, isWebTransportSupported: () => webTransport } } as never, Reload }
}

const relay = { url: 'https://relay.test/token', bridge: '/moq-bridge' }

describe('watchConnection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the Mac app WebView through the bridge even when the MoQ client would use its WebTransport', () => {
    vi.stubGlobal('navigator', { userAgent: WKWEBVIEW })
    const { net, Reload } = fakeNet(true)
    watchConnection(net, relay)
    const { url, websocket } = Reload.mock.calls[0][0] as { url: URL; websocket: { enabled: boolean } }
    expect(url.pathname).toBe('/moq-bridge')
    expect(websocket.enabled).toBe(true)
  })

  it('lets Chrome watch the relay directly', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME })
    const { net, Reload } = fakeNet(true)
    watchConnection(net, relay)
    const { url, websocket } = Reload.mock.calls[0][0] as { url: URL; websocket: { enabled: boolean } }
    expect(url.href).toBe('https://relay.test/token')
    expect(websocket.enabled).toBe(false)
  })
})
