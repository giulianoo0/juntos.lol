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

/** `finalUrl` is where the response came from after redirects, which the policy re-checks. */
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
  signal?: AbortSignal
}

export type RunFailure = 'timeout' | 'too-many-requests' | 'plugin-error' | 'aborted'

export class PluginRunError extends Error {
  readonly reason: RunFailure
  constructor(reason: RunFailure, message: string) {
    super(message)
    this.name = 'PluginRunError'
    this.reason = reason
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REQUESTS = 32

export function runPlugin(options: RunPluginOptions): Promise<unknown> {
  const { hosts, selfOrigin, spawn, fetchUrl } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS

  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let requests = 0
    let handle: PluginHandle | null = null
    const outbox: WorkerReply[] = []
    const inflight = new AbortController()

    const post = (reply: WorkerReply) => {
      if (handle) handle.post(reply)
      else outbox.push(reply)
    }

    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      inflight.abort()
      handle?.terminate()
      run()
    }

    const timer = window.setTimeout(() => {
      finish(() => reject(new PluginRunError('timeout', `plugin exceeded ${timeoutMs}ms`)))
    }, timeoutMs)

    const onAbort = () => finish(() => reject(new PluginRunError('aborted', 'plugin run was cancelled')))
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

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
      if (message.kind !== 'fetch' || typeof message.url !== 'string' || typeof message.id !== 'number') return
      requests += 1
      if (requests > maxRequests) {
        finish(() => reject(new PluginRunError('too-many-requests', `plugin exceeded ${maxRequests} requests`)))
        return
      }
      const decision = checkFetchUrl(message.url, hosts, selfOrigin)
      if (!decision.ok) {
        post({ id: message.id, ok: false, status: 0, text: `blocked: ${decision.reason}` })
        return
      }
      fetchUrl(decision.url, inflight.signal)
        .then(({ finalUrl, ...response }) => {
          if (settled) return
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
    if (settled) handle.terminate()
    else for (const reply of outbox.splice(0)) handle.post(reply)
  })
}
