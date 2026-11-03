/**
 * The TV's own socket, `/ws/tv`: the server pushes `cast`, `stop`, `mix` and
 * `revoked` down it. It comes back by itself after a drop, waiting longer
 * each time, until closed.
 */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 8_000

export interface TvChannel {
  /** False when the socket is down; nothing is queued. */
  send(message: Record<string, unknown>): boolean
  close(): void
}

export function openTvChannel(token: string, handlers: {
  onMessage(message: { type: string } & Record<string, unknown>): void
  /** Each time the socket opens, the first time and after every drop. */
  onOpen(): void
  /** A socket turned away before it opened: the token may be gone. */
  onRefused(): void
}): TvChannel {
  let socket: WebSocket | null = null
  let closed = false
  let attempt = 0
  let retry: number | null = null

  const connect = () => {
    if (closed) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = new WebSocket(`${scheme}//${window.location.host}/ws/tv?token=${encodeURIComponent(token)}`)
    socket = current
    let opened = false
    current.onopen = () => {
      opened = true
      attempt = 0
      handlers.onOpen()
    }
    current.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: unknown }
        if (typeof message.type === 'string') handlers.onMessage(message as { type: string })
      } catch { /* not ours */ }
    }
    current.onclose = () => {
      if (closed || socket !== current) return
      socket = null
      if (!opened) handlers.onRefused()
      const backoff = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
      attempt += 1
      retry = window.setTimeout(connect, backoff * (0.75 + Math.random() * 0.5))
    }
  }

  connect()

  return {
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
    close() {
      closed = true
      if (retry !== null) window.clearTimeout(retry)
      socket?.close()
      socket = null
    },
  }
}
