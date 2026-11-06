import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepAskingForRelay, relayConnection, watchConnection } from './moq'

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

  it('lets Chrome watch the relay directly, with the bridge as the way in when UDP is blocked', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME })
    vi.stubGlobal('location', { href: 'https://juntos.test/room/R1' })
    const { net, Reload } = fakeNet(true)
    watchConnection(net, relay)
    const { url, websocket } = Reload.mock.calls[0][0] as { url: URL; websocket: { enabled: boolean; url: URL; delay: number } }
    expect(url.href).toBe('https://relay.test/token')
    expect(websocket.enabled).toBe(true)
    expect(websocket.url.href).toBe('https://juntos.test/moq-bridge')
    expect(websocket.delay).toBeGreaterThan(0)
  })

  it('keeps Chrome on the relay alone when the server names no bridge', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME })
    const { net, Reload } = fakeNet(true)
    watchConnection(net, { url: relay.url })
    const { websocket } = Reload.mock.calls[0][0] as { websocket: { enabled: boolean } }
    expect(websocket.enabled).toBe(false)
  })
})

describe('relayConnection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('publishes over QUIC and falls back to the publish bridge when UDP is blocked', () => {
    vi.stubGlobal('location', { href: 'https://juntos.test/room/R1' })
    const { net, Reload } = fakeNet(true)
    relayConnection(net, 'https://relay.test/pub', '/moq-bridge?t=w')
    const { url, websocket } = Reload.mock.calls[0][0] as { url: URL; websocket: { enabled: boolean; url: URL; delay: number } }
    expect(url.href).toBe('https://relay.test/pub')
    expect(websocket.enabled).toBe(true)
    expect(websocket.url.href).toBe('https://juntos.test/moq-bridge?t=w')
    expect(websocket.delay).toBeGreaterThan(0)
  })

  it('publishes over QUIC alone without a publish bridge', () => {
    const { net, Reload } = fakeNet(true)
    relayConnection(net, 'https://relay.test/pub')
    const { websocket } = Reload.mock.calls[0][0] as { websocket: { enabled: boolean } }
    expect(websocket.enabled).toBe(false)
  })
})

describe('keepAskingForRelay', () => {
  afterEach(() => { vi.useRealTimers() })

  it('asks again while the room relay is being made, and stops at a server with none', async () => {
    vi.useFakeTimers()
    const answers = [new Error('relay_unavailable'), new Error('relay_unavailable'), { url: 'r' }]
    const ask = vi.fn(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next
    })
    const got = vi.fn()
    keepAskingForRelay(ask, got, 'call_disabled')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(got).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(got).toHaveBeenCalledWith({ url: 'r' })
    expect(ask).toHaveBeenCalledTimes(3)

    const refused = vi.fn(async () => { throw new Error('call_disabled') })
    keepAskingForRelay(refused, got, 'call_disabled')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('asks no more once cancelled', async () => {
    vi.useFakeTimers()
    const ask = vi.fn(async () => { throw new Error('relay_unavailable') })
    const cancel = keepAskingForRelay(ask, vi.fn(), 'call_disabled')
    await vi.advanceTimersByTimeAsync(0)
    cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
