import type { FetchResult, PluginHandle, SpawnOptions, WorkerRequest } from './runtime'

/** How much of a response body is worth reading. Generous for addon JSON. */
export const MAX_BODY_BYTES = 4 << 20

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

/** Where the server performs a plugin's request. See pluginfetch.go. */
export const HOP_PATH = '/api/plugins/fetch'

/**
 * The page asking the server to perform what a plugin asked for. Only
 * reached after the policy said yes.
 *
 * The page does not perform the request itself, and cannot: the browser
 * stamps every cross-site request with this page's Origin, no script can
 * remove it, and Torrentio answers 502 to any Origin that is not Stremio's.
 * The server sends the request the way curl would — no Origin, no cookie of
 * ours — and hands back the addon's status, its body, and where the answer
 * landed. Same-origin credentials on purpose: the session cookie is the
 * hop's budget.
 *
 * `finalUrl` travels back so the runtime can apply the allowlist to where the
 * response came from — following the redirect and then checking is the only
 * order available, since neither the browser nor the hop reports the hops.
 * An answer with no landing url is the hop failing, not the addon, and is
 * thrown rather than handed to the plugin as an answer.
 */
export async function pageFetch(url: URL, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(`${HOP_PATH}?url=${encodeURIComponent(url.toString())}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  })
  const finalUrl = response.headers.get('X-Final-Url')
  if (!finalUrl) {
    throw new Error(`hop ${response.status}: ${await readCapped(response, 1 << 10, signal)}`)
  }
  return {
    ok: response.ok,
    status: response.status,
    text: await readCapped(response, MAX_BODY_BYTES, signal),
    finalUrl,
  }
}

/**
 * Reads at most `limit` bytes. `await response.text()` has no ceiling, and 32
 * requests times an unbounded body is the host's tab downloading gigabytes on
 * a plugin's say-so.
 *
 * It truncates rather than throwing, which suits a response body a plugin
 * asked for. A caller that must not accept a truncated answer — the plugin's
 * own source, say — passes `limit + 1` and refuses anything longer.
 */
export async function readCapped(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let seen = 0
  try {
    for (;;) {
      // An abort is a failure, not a short read. Breaking here would hand a
      // truncated body back marked `ok: true`.
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen > limit) {
        out += decoder.decode(value.slice(0, value.byteLength - (seen - limit)), { stream: true })
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
