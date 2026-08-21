/// <reference lib="webworker" />

/**
 * The bootstrap a plugin wakes up inside.
 *
 * Three layers, and no single one of them is enough.
 *
 * 1. The header. This script is served with
 *    `Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'`.
 *    It is the only layer plugin code cannot reach around by construction, and
 *    the only thing that stops a dynamic `import()` of a remote module —
 *    which, from in here, nothing can remove.
 *
 * 2. The scope, below. Note that it deletes along the prototype chain rather
 *    than assigning `undefined` to `self`. `fetch` and friends live on
 *    `WorkerGlobalScope.prototype`, so an own-property assignment only
 *    shadows them, and `Object.getPrototypeOf(self).fetch` walks straight
 *    past it. `Worker` is on the list for the same class of reason: a nested
 *    worker is born with an untouched scope, and it would make everything
 *    above pointless.
 *
 * 3. The page. `api.fetch` is a message, and the page decides — including
 *    where a redirect landed. See runtime.ts.
 *
 * What is deliberately NOT claimed: that a plugin cannot compute whatever it
 * likes, or that it cannot return a magnet the room will open. Trust ends
 * with whoever wrote the plugin. What is enforced is that it never reaches
 * this site's own origin, its API, or its storage.
 */

const BLOCKED = [
  // Network.
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
  'RTCPeerConnection', 'importScripts',
  // Storage, and the channels that reach other contexts of this origin.
  'caches', 'indexedDB', 'BroadcastChannel', 'Notification',
  // Anywhere a fresh, untouched scope could be obtained.
  'Worker', 'SharedWorker',
  // navigator carries sendBeacon, serviceWorker and storage. A plugin has no
  // business with any of it, so the whole object goes.
  'navigator',
]

for (const name of BLOCKED) {
  // Delete wherever it actually lives, not only where it appears to.
  for (let object: object | null = self; object; object = Object.getPrototypeOf(object) as object | null) {
    if (!Object.prototype.hasOwnProperty.call(object, name)) continue
    try {
      delete (object as Record<string, unknown>)[name]
    } catch {
      // Non-configurable: the defineProperty below is the second attempt.
    }
  }
  try {
    Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false })
  } catch {
    // Nothing more to do from in here. The CSP header is what this rests on.
  }
}

interface Reply {
  ok: boolean
  status: number
  text: string
}

const pending = new Map<number, (reply: Reply) => void>()
let nextId = 0

const api = {
  fetch(url: string) {
    const id = (nextId += 1)
    return new Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>(
      (resolve) => {
        pending.set(id, (reply) => resolve({
          ok: reply.ok,
          status: reply.status,
          text: () => Promise.resolve(reply.text),
          json: () => Promise.resolve(JSON.parse(reply.text) as unknown),
        }))
        self.postMessage({ kind: 'fetch', id, url })
      },
    )
  },
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>
  if (data.kind === 'reply') {
    const resolve = pending.get(data.id as number)
    if (!resolve) return
    pending.delete(data.id as number)
    resolve(data as unknown as Reply)
    return
  }
  if (data.kind !== 'start') return
  void (async () => {
    try {
      const module = await import(/* @vite-ignore */ data.pluginUrl as string) as {
        manifest?: unknown
        streams?: (target: unknown, api: unknown) => Promise<unknown>
      }
      // Importing already ran the plugin's top level. That it happened in
      // here and not in the page is the whole point of reading the manifest
      // through this path.
      if (data.op === 'manifest') {
        self.postMessage({ kind: 'done', streams: module.manifest })
        return
      }
      if (typeof module.streams !== 'function') throw new Error('plugin has no streams export')
      self.postMessage({ kind: 'done', streams: await module.streams(data.target, api) })
    } catch (error) {
      self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  })()
}
