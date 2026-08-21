import { checkFetchUrl } from './policy'

export type WorkerRequest =
  | { kind: 'fetch'; id: number; url: string }
  | { kind: 'done'; streams: unknown }
  | { kind: 'error'; message: string }

export interface WorkerReply {
  id: number
  ok: boolean
  status: number
  text: string
}

export interface PluginHandle {
  post(reply: WorkerReply): void
  terminate(): void
}

export interface SpawnOptions {
  onMessage(message: WorkerRequest): void
}

/**
 * What the page reports back about a request it performed.
 *
 * `finalUrl` is where the response actually came from. It matters because a
 * declared host is free to answer 302 and send the page somewhere else, and a
 * policy that only inspects the request is a pre-flight policy.
 */
export interface FetchResult {
  ok: boolean
  status: number
  text: string
  finalUrl?: string
}

export interface RunPluginOptions {
  hosts: string[]
  selfOrigin: string
  spawn(options: SpawnOptions): PluginHandle
  fetchUrl(url: URL, signal: AbortSignal): Promise<FetchResult>
  timeoutMs?: number
  maxRequests?: number
}

export type RunFailure = 'timeout' | 'too-many-requests' | 'plugin-error'

export class PluginRunError extends Error {
  readonly reason: RunFailure
  constructor(reason: RunFailure, message: string) {
    super(message)
    this.name = 'PluginRunError'
    this.reason = reason
  }
}

/** A resolution that has not finished in this long is not going to. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Enough for a paginated addon, far short of using the page as a crawler. */
const DEFAULT_MAX_REQUESTS = 32

export function runPlugin(options: RunPluginOptions): Promise<unknown> {
  const { hosts, selfOrigin, spawn, fetchUrl } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS

  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let requests = 0
    let handle: PluginHandle | null = null
    // Replies produced before `spawn` returns would be posted into a null
    // handle and lost in silence. They wait here instead.
    const outbox: WorkerReply[] = []
    // Everything the page has in flight for this plugin, cancelled together
    // with the worker. Without it the time ceiling kills the worker and the
    // requests it started keep running.
    const inflight = new AbortController()

    const post = (reply: WorkerReply) => {
      if (handle) handle.post(reply)
      else outbox.push(reply)
    }

    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      inflight.abort()
      handle?.terminate()
      run()
    }

    const timer = window.setTimeout(() => {
      finish(() => reject(new PluginRunError('timeout', `plugin exceeded ${timeoutMs}ms`)))
    }, timeoutMs)

    const onMessage = (message: WorkerRequest) => {
      if (settled) return
      if (message.kind === 'done') {
        finish(() => resolve(message.streams))
        return
      }
      if (message.kind === 'error') {
        finish(() => reject(new PluginRunError('plugin-error', `plugin failed: ${message.message}`)))
        return
      }
      // Counted before the policy runs, so a plugin cannot spend an unlimited
      // budget on requests that are going to be refused anyway.
      requests += 1
      if (requests > maxRequests) {
        finish(() => reject(new PluginRunError('too-many-requests', `plugin exceeded ${maxRequests} requests`)))
        return
      }
      const decision = checkFetchUrl(message.url, hosts, selfOrigin)
      if (!decision.ok) {
        // A refusal is answered rather than thrown: a plugin that asks for
        // something it may not have should get to handle that, the same as it
        // would handle a server saying no.
        post({ id: message.id, ok: false, status: 0, text: `blocked: ${decision.reason}` })
        return
      }
      fetchUrl(decision.url, inflight.signal)
        .then(({ finalUrl, ...response }) => {
          if (settled) return
          // The allowlist applies to where the response came from, not only to
          // where the request went.
          const landed = finalUrl ? checkFetchUrl(finalUrl, hosts, selfOrigin) : null
          if (landed && !landed.ok) {
            post({ id: message.id, ok: false, status: 0, text: `blocked: redirect-${landed.reason}` })
            return
          }
          post({ id: message.id, ...response })
        })
        .catch((error: unknown) => {
          if (!settled) post({ id: message.id, ok: false, status: 0, text: String(error) })
        })
    }

    handle = spawn({ onMessage })
    // `spawn` may have called `onMessage` synchronously, in which case the
    // run is already over or there are replies waiting.
    if (settled) handle.terminate()
    else for (const reply of outbox.splice(0)) handle.post(reply)
  })
}
