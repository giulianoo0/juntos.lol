/**
 * A POST to a client-media endpoint that outlasts a long preparo: transient
 * failures (5xx, 429, a dropped connection mid-deploy) are waited out, since
 * giving up threw the whole room away. A 4xx carries a code the server meant
 * and comes back at once.
 */

/** Server answers worth trying again; everything else is the server's verdict. */
function transient(status: number): boolean {
  return status >= 500 || status === 429
}

export interface PostJsonOptions {
  signal?: AbortSignal
  attempts?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 400
const BACKOFF_CAP_MS = 5_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POSTs `body` as JSON. Any 2xx and any 4xx come back as they are, for the
 * caller to read the code off; a 5xx, a 429 or a dropped connection is
 * retried, and the last response (or network error) is what survives.
 */
export async function postJson(url: string, body: unknown, options: PostJsonOptions = {}): Promise<Response> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = options.sleep ?? wait
  let lastResponse: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.min(BACKOFF_CAP_MS, backoffMs * 2 ** (attempt - 1)))
      if (options.signal?.aborted) break
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal,
        body: JSON.stringify(body),
      })
      if (response.ok || !transient(response.status)) return response
      void response.body?.cancel().catch(() => undefined)
      lastResponse = response
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }
  }
  if (lastResponse) return lastResponse
  throw lastError ?? new Error(`post failed: ${url}`)
}
