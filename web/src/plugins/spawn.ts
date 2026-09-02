import type { FetchResult, PluginHandle, SpawnOptions, WorkerRequest } from './runtime'

export const MAX_BODY_BYTES = 4 << 20

function start(source: string, message: Record<string, unknown>) {
  return (options: SpawnOptions): PluginHandle => {
    const pluginUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      URL.revokeObjectURL(pluginUrl)
      throw error
    }
    worker.onmessage = (event: MessageEvent) => options.onMessage(event.data as WorkerRequest)
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

export function spawnPluginWorker(source: string, target: unknown) {
  return start(source, { op: 'streams', target })
}

export function spawnManifestReader(source: string) {
  return start(source, { op: 'manifest' })
}

/** Where the server performs a plugin's request. See pluginfetch.go. */
export const HOP_PATH = '/api/plugins/fetch'

/**
 * The page asking the server to perform what a plugin asked for, after the
 * policy said yes. `finalUrl` travels back so the allowlist can be re-applied
 * to where the answer landed; an answer with no landing url is the hop failing.
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
 * Truncates at `limit` rather than throwing; a caller that must refuse a
 * truncated answer passes `limit + 1` and rejects anything longer.
 */
export async function readCapped(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let seen = 0
  try {
    for (;;) {
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
  return out + decoder.decode()
}
