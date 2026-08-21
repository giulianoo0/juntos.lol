import type { FetchResult, PluginHandle, SpawnOptions, WorkerRequest } from './runtime'

/** How much of a response body is worth reading. Generous for addon JSON. */
const MAX_BODY_BYTES = 4 << 20

function start(source: string, message: Record<string, unknown>) {
  return (options: SpawnOptions): PluginHandle => {
    const pluginUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      // A worker the CSP refused, or a chunk that is not there. The blob would
      // otherwise leak for the life of the page.
      URL.revokeObjectURL(pluginUrl)
      throw error
    }
    worker.onmessage = (event: MessageEvent) => options.onMessage(event.data as WorkerRequest)
    // Without these, a worker script that fails to load — a misconfigured CSP,
    // a chunk that was never emitted — is silence, and the run dies fifteen
    // seconds later reporting a timeout. You would go looking at the plugin.
    worker.onerror = (event) => options.onMessage({
      kind: 'error',
      message: (event instanceof ErrorEvent && event.message) || 'plugin worker failed to load',
    })
    worker.onmessageerror = () => options.onMessage({ kind: 'error', message: 'plugin sent an unreadable message' })
    worker.postMessage({ kind: 'start', pluginUrl, ...message })
    return {
      post: (reply) => worker.postMessage({ kind: 'reply', ...reply }),
      terminate: () => {
        worker.terminate()
        URL.revokeObjectURL(pluginUrl)
      },
    }
  }
}

/** A worker running this plugin's source, told which title to resolve. */
export function spawnPluginWorker(source: string, target: unknown) {
  return start(source, { op: 'streams', target })
}

/**
 * A worker that imports the plugin and reports its manifest.
 *
 * Reading a manifest means running the module's top level, and running it in
 * the page would hand the plugin localStorage, the registry of every other
 * installed plugin, and a same-origin `/api`. Installing and updating both
 * come through here, and updating runs unattended on every page load.
 */
export function spawnManifestReader(source: string) {
  return start(source, { op: 'manifest' })
}

/**
 * The page performing what a plugin asked for. Only reached after the policy
 * said yes; `no-store` and `omit` keep this out of the cache and stop any
 * cookie of ours from riding along.
 *
 * `finalUrl` travels back so the runtime can apply the allowlist to where the
 * response came from — following the redirect and then checking is the only
 * order available to a browser, which will not tell us the hops.
 */
export async function pageFetch(url: URL, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(url.toString(), {
    credentials: 'omit', cache: 'no-store', redirect: 'follow', signal,
  })
  return {
    ok: response.ok,
    status: response.status,
    text: await readCapped(response, signal),
    finalUrl: response.url || url.toString(),
  }
}

/**
 * Reads at most MAX_BODY_BYTES. `await response.text()` has no ceiling, and
 * 32 requests times an unbounded body is the host's tab downloading gigabytes
 * on a plugin's say-so.
 */
async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let seen = 0
  try {
    for (;;) {
      // An abort is a failure, not a short read. Breaking here would hand a
      // truncated body back marked `ok: true`.
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen > MAX_BODY_BYTES) {
        out += decoder.decode(value.slice(0, value.byteLength - (seen - MAX_BODY_BYTES)), { stream: true })
        break
      }
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  // Flush whatever multi-byte sequence was left half-read.
  return out + decoder.decode()
}
