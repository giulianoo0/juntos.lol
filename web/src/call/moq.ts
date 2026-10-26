/**
 * What every broadcast of a room shares, screens and cameras alike: how a
 * browser reaches the Cloudflare relay (or, for WebKit, the bridge that
 * stands in for it) and how a publisher knows the relay took its broadcast.
 */
import type * as Publish from '@moq/publish'

/** The reconnect loop never gives up on its own; leaving the room is what stops it. */
const RELAY_RETRY = { initial: 1000, multiplier: 2, max: 5000, timeout: 0 }
/** How long a publisher may take to get its broadcast onto the relay before it counts as failed. */
const PUBLISH_READY_MS = 15_000

type Net = typeof Publish.Net

/**
 * Whether this engine is WebKit: Safari, and every browser on iOS. Its
 * WebTransport stalls long sessions, so it watches through the bridge, which
 * only carries broadcasts one way.
 */
export function isWebKit(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg)\//.test(userAgent)
}

/** Whether this browser can publish to the relay: QUIC and both directions of WebCodecs. */
export function relayPublishSupported(): boolean {
  return typeof WebTransport !== 'undefined'
    && typeof VideoEncoder !== 'undefined'
    && typeof VideoDecoder !== 'undefined'
    && !isWebKit()
}

export function relayConnection(net: Net, url: string): Publish.Net.Connection.Reload {
  // The relay speaks QUIC only; racing a WebSocket it will never answer just delays the connect.
  return new net.Connection.Reload({ url: new URL(url), enabled: true, websocket: { enabled: false }, delay: RELAY_RETRY })
}

/**
 * A viewer's way in: the relay itself, or the bridge when the MoQ client will
 * not use this browser's WebTransport (it refuses every WebKit) and the
 * server names one. The bridge speaks WebSocket only.
 */
export function watchConnection(net: Net, relay: { url: string; bridge?: string }): Publish.Net.Connection.Reload {
  if (relay.bridge && !net.Connection.isWebTransportSupported()) {
    const url = new URL(relay.bridge, location.href)
    return new net.Connection.Reload({ url, enabled: true, websocket: { enabled: true, delay: 0 }, delay: RELAY_RETRY })
  }
  return relayConnection(net, relay.url)
}

/**
 * Resolves once the broadcast is on the relay. Only then may the room be told
 * it exists: a viewer that subscribes earlier finds no track.
 */
export function whenPublished(broadcast: Publish.Broadcast): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (broadcast.net.peek()) { resolve(); return }
    const timer = setTimeout(() => {
      stop()
      reject(new Error('relay did not accept the broadcast in time'))
    }, PUBLISH_READY_MS)
    const stop = broadcast.net.subscribe((producer) => {
      if (!producer) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}
