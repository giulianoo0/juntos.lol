/// <reference lib="webworker" />

/**
 * The bootstrap a plugin wakes up inside.
 *
 * Three layers, and no single one of them is enough.
 *
 * 1. The header. This script is served with
 *    `Content-Security-Policy: default-src 'none'; script-src blob:`.
 *    It is the only layer plugin code cannot reach around by construction,
 *    and the only thing that stops `import('https://…')` — which fetches the
 *    URL before rejecting it, making it an exfiltration channel of arbitrary
 *    width that nothing inside a worker can close.
 *
 * 2. The scope, below.
 *
 * 3. The page. `api.fetch` is a message, and the page decides — including
 *    where a redirect landed — before asking the server to perform the
 *    request. See runtime.ts and spawn.ts.
 *
 * The scope is trimmed to an **allowlist**, and that is a deliberate reversal.
 * A denylist of dangerous globals loses to every API the platform ships:
 * writing one carefully still left `WebSocketStream` (a second, differently
 * spelled WebSocket) and `webkitRequestFileSystemSync` (persistent storage
 * with a global entry point that does not go through `navigator`) reachable.
 * Enumerating what a plugin may keep is the only form that does not decay.
 *
 * Deleting walks the prototype chain rather than assigning to `self`, because
 * `fetch` and friends live on `WorkerGlobalScope.prototype` and an own-property
 * assignment merely shadows them.
 *
 * What is deliberately NOT claimed: that a plugin cannot compute whatever it
 * likes, or that it cannot return a magnet the room will open. Trust ends with
 * whoever wrote the plugin. What is enforced is that it never reaches this
 * site's own origin, its API, or its storage.
 */

const ALLOWED = new Set([
  // --- The global itself, and the message port that is the only way out.
  'self', 'globalThis', 'postMessage', 'onmessage', 'onmessageerror', 'close',
  'onerror', 'onunhandledrejection', 'onrejectionhandled',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'constructor',
  'EventTarget', 'Event', 'MessageEvent', 'ErrorEvent', 'PromiseRejectionEvent',
  'DOMException', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope',

  // --- ECMAScript. Inert by construction: no I/O, no persistence.
  'Object', 'Function', 'Boolean', 'Symbol', 'Array', 'Number', 'BigInt',
  'String', 'RegExp', 'Date', 'Math', 'JSON', 'Promise', 'Proxy', 'Reflect',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError', 'AggregateError', 'Intl', 'Iterator',
  'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
  'DisposableStack', 'AsyncDisposableStack', 'SuppressedError',
  'undefined', 'NaN', 'Infinity', 'eval', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape',

  // --- Utilities with no reach outside this worker.
  'console', 'crypto', 'Crypto', 'SubtleCrypto', 'CryptoKey',
  'performance', 'Performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'reportError',
  'atob', 'btoa',
  'TextEncoder', 'TextDecoder', 'TextEncoderStream', 'TextDecoderStream',
  'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal',
  'Blob', 'CompressionStream', 'DecompressionStream',
  'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
  'ReadableStreamDefaultController', 'ReadableByteStreamController',
  'ReadableStreamBYOBRequest', 'WritableStream', 'WritableStreamDefaultWriter',
  'WritableStreamDefaultController', 'TransformStream',
  'TransformStreamDefaultController', 'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
])

// Object.prototype is where `hasOwnProperty` and `toString` live. Trimming it
// would break the plugin, this file, and the module loader alike.
for (let scope: object | null = self; scope && scope !== Object.prototype; scope = Object.getPrototypeOf(scope) as object | null) {
  for (const name of Object.getOwnPropertyNames(scope)) {
    if (ALLOWED.has(name)) continue
    try {
      delete (scope as Record<string, unknown>)[name]
    } catch {
      // Non-configurable. The defineProperty below is the second attempt, and
      // the CSP header is what this ultimately rests on.
    }
    try {
      Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false })
    } catch { /* see above */ }
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
