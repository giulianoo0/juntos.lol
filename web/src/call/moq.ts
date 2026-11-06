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
/** QUIC's head start on the bridge: a reachable relay answers well inside it, so the VPS only carries viewers whose UDP is gone. */
const BRIDGE_HEADSTART_MS = 2000

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

/**
 * The relay over QUIC, raced against the bridge over TCP when the server
 * names one. The relay itself never answers a WebSocket, so without a bridge
 * there is nothing to race.
 */
export function relayConnection(net: Net, url: string, bridge?: string): Publish.Net.Connection.Reload {
  const websocket = bridge
    ? { enabled: true, url: new URL(bridge, location.href), delay: BRIDGE_HEADSTART_MS }
    : { enabled: false }
  return new net.Connection.Reload({ url: new URL(url), enabled: true, websocket, delay: RELAY_RETRY })
}

/**
 * A viewer's way in: the relay itself, or the bridge for every WebKit when the
 * server names one. WebKit never hands receive credit back (bug 319818: no
 * MAX_DATA or MAX_STREAMS after the first ~16 MiB), so a viewer on it stalls
 * within seconds. The MoQ client only spots Safari by its version: the Mac
 * app's WKWebView, which names none, has to be caught here. The bridge
 * speaks WebSocket only.
 *
 * Everyone else races the relay over QUIC against the bridge over TCP, the
 * bridge starting late: a network that drops UDP never answers QUIC, and
 * without the bridge that viewer would sit on "connecting" in every browser.
 */
export function watchConnection(net: Net, relay: { url: string; bridge?: string }): Publish.Net.Connection.Reload {
  if (relay.bridge && (isWebKit() || !net.Connection.isWebTransportSupported())) {
    const bridge = new URL(relay.bridge, location.href)
    return new net.Connection.Reload({ url: bridge, enabled: true, websocket: { enabled: true, delay: 0 }, delay: RELAY_RETRY })
  }
  return relayConnection(net, relay.url, relay.bridge)
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

/**
 * What a relay handout's failure says: `disabled` when the server has no
 * relay at all, `relay_unavailable` when the room's own relay could not be
 * made just now and asking again may get it.
 */
export async function relayRefusal(response: Response, disabled: string): Promise<Error> {
  if (response.status !== 503) return new Error(`relay handout ${response.status}`)
  const body = await response.json().catch(() => ({})) as { error?: string }
  return new Error(body.error === 'relay_unavailable' ? 'relay_unavailable' : disabled)
}

const RELAY_RETRY_FIRST_MS = 2_000
const RELAY_RETRY_MAX_MS = 30_000

/**
 * Asks for the room's relay until it comes: a room's relay is made on the
 * first ask, and a refusal then is a moment, not an answer. A server with no
 * relay at all is the one answer that ends it. Returns the canceller.
 */
export function keepAskingForRelay<T>(ask: () => Promise<T>, got: (relay: T) => void, disabled: string): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = (wait: number) => {
    ask().then((relay) => { if (!cancelled) got(relay) }, (error: unknown) => {
      if (cancelled || (error instanceof Error && error.message === disabled)) return
      timer = setTimeout(() => attempt(Math.min(wait * 2, RELAY_RETRY_MAX_MS)), wait)
    })
  }
  attempt(RELAY_RETRY_FIRST_MS)
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
  }
}
