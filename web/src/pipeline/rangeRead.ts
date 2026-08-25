/**
 * Ranged reads over HTTP that survive a WAN. A remote worker answers a Range
 * as the pieces arrive, caps a response at a few MiB, ends a body early when
 * a piece stalls, and blips a 5xx now and then — none of which may reach
 * mediabunny, which treats a short read as fatal and a thrown read as a
 * worker's unhandled rejection. So every read here resumes from its own byte
 * counter, retries with backoff, and only ever throws for two reasons: the
 * read was aborted on purpose, or the failure is terminal.
 *
 * Two things stay deliberately separate: the retry budget (consecutive
 * failures that made no progress) and the deadline (wall-clock for a body
 * that shows no bytes at all). A read parked on pieces the swarm has not
 * fetched yet is slow, not broken — it must not exhaust either.
 */

/** A read was aborted by its gate — the seek moved on, the session closed. */
export class ReadAbortedError extends Error {
  constructor() {
    super('read aborted')
    this.name = 'ReadAbortedError'
  }
}

/** The origin will not serve this read no matter how often it is asked. */
export class ReadFailedError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ReadFailedError'
    this.status = status
  }
}

/** Nothing usable came back within the retry budget or the deadline. */
export class ReadUnreachableError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('origin unreachable')
    this.name = 'ReadUnreachableError'
    this.cause = cause
  }
}

/**
 * The mutable abort a MediaInput hands to every read it starts. mediabunny
 * gives `read` no signal, so the closure asks the gate for the current one;
 * aborting replaces it, and reads started afterwards ride the fresh signal.
 */
export class ReadGate {
  private controller = new AbortController()
  private closed = false
  get signal(): AbortSignal { return this.controller.signal }
  /** Aborts every read in flight; later reads start clean. */
  abort(): void {
    this.controller.abort()
    if (!this.closed) this.controller = new AbortController()
  }
  /** Aborts and refuses every read from now on. */
  close(): void {
    this.closed = true
    this.controller.abort()
  }
}

export interface RangeReaderOptions {
  /** Read at call time so a rotated ticket applies to the next request. */
  url: () => string
  size: number
  gate: ReadGate
  /** Consecutive attempts that delivered nothing before giving up. */
  maxAttempts?: number
  /** Wall-clock a single request may take to show its first byte. */
  firstByteMs?: number
  /** Called on 401/403 once per read; a true return means "try again". */
  refresh?: () => Promise<boolean>
  /** Bytes delivered, for throughput accounting. */
  onBytes?: (n: number) => void
  /** Extra request headers, e.g. a priority class. */
  headers?: Record<string, string>
}

const DEFAULT_ATTEMPTS = 8
const DEFAULT_FIRST_BYTE_MS = 45_000
const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 8_000
const TERMINAL_STATUSES = new Set([400, 404, 410, 416])

function backoff(attempt: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return base / 2 + Math.random() * base / 2
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ReadAbortedError()); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new ReadAbortedError()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Streams `[start, end)` as chunks, across as many requests as it takes.
 * The stream only closes once every byte has been delivered, which is what
 * mediabunny's strictness demands; anything short of that is an error.
 */
export function rangeStream(opts: RangeReaderOptions, start: number, end: number): ReadableStream<Uint8Array> {
  const signal = opts.gate.signal
  const target = Math.min(end, opts.size)
  let cursor = start
  let attempts = 0
  let refreshed = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let requestAbort: AbortController | null = null

  const onGateAbort = () => requestAbort?.abort()
  signal.addEventListener('abort', onGateAbort, { once: true })

  const settle = () => {
    signal.removeEventListener('abort', onGateAbort)
    reader?.cancel().catch(() => {})
    requestAbort?.abort()
  }

  // Opens one request at the cursor. Resolves with a body reader, or null
  // when the attempt failed recoverably and the caller should retry.
  const open = async (): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
    requestAbort = new AbortController()
    if (signal.aborted) throw new ReadAbortedError()
    const firstByte = setTimeout(() => requestAbort?.abort(), opts.firstByteMs ?? DEFAULT_FIRST_BYTE_MS)
    let response: Response
    try {
      response = await fetch(opts.url(), {
        signal: requestAbort.signal,
        headers: { ...opts.headers, Range: `bytes=${cursor}-${target - 1}` },
      })
    } catch (error) {
      clearTimeout(firstByte)
      if (signal.aborted) throw new ReadAbortedError()
      return null
    }
    clearTimeout(firstByte)
    if (response.status === 401 || response.status === 403) {
      if (!refreshed && opts.refresh && await opts.refresh()) { refreshed = true; return null }
      throw new ReadFailedError(response.status, `read refused (${response.status})`)
    }
    if (TERMINAL_STATUSES.has(response.status)) throw new ReadFailedError(response.status, `read failed (${response.status})`)
    if (response.status !== 206 && response.status !== 200) {
      response.body?.cancel().catch(() => {})
      return null
    }
    if (response.status === 200 && cursor !== 0) {
      // An origin that ignored Range would make us skip ahead; refuse it.
      response.body?.cancel().catch(() => {})
      throw new ReadFailedError(200, 'origin ignored Range')
    }
    if (!response.body) return null
    return response.body.getReader()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (cursor < target) {
          if (signal.aborted) throw new ReadAbortedError()
          if (!reader) {
            if (attempts >= (opts.maxAttempts ?? DEFAULT_ATTEMPTS)) {
              throw new ReadUnreachableError(`no progress after ${attempts} attempts at byte ${cursor}`)
            }
            reader = await open()
            if (!reader) {
              attempts += 1
              await sleep(backoff(attempts), signal)
              continue
            }
          }
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await reader.read()
          } catch (error) {
            if (signal.aborted) throw new ReadAbortedError()
            // The body died under us — network, or the origin ending it early.
            reader = null
            attempts += 1
            await sleep(backoff(attempts), signal)
            continue
          }
          if (result.done) {
            // The origin closed the body. With progress made this is the
            // worker's cap or stall policy and costs nothing; without it the
            // origin gave up before a single byte, which is a failed attempt.
            reader = null
            continue
          }
          let chunk = result.value
          if (chunk.byteLength === 0) continue
          // An origin that over-delivers is truncated, never trusted.
          const room = target - cursor
          if (chunk.byteLength > room) chunk = chunk.subarray(0, room)
          cursor += chunk.byteLength
          attempts = 0
          opts.onBytes?.(chunk.byteLength)
          controller.enqueue(chunk)
          return
        }
        settle()
        controller.close()
      } catch (error) {
        settle()
        controller.error(error)
      }
    },
    cancel() {
      settle()
    },
  })
}

/** Reads `[start, end)` whole; for scans and probes that want a buffer. */
export async function rangeBytes(opts: RangeReaderOptions, start: number, end: number): Promise<Uint8Array> {
  const target = Math.min(end, opts.size)
  if (target <= start) return new Uint8Array(0)
  const out = new Uint8Array(target - start)
  let at = 0
  const reader = rangeStream(opts, start, target).getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.set(value, at)
    at += value.byteLength
  }
  return out
}
