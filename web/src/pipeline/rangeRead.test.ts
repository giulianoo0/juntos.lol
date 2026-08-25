import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadAbortedError, ReadFailedError, ReadGate, ReadUnreachableError, rangeBytes, rangeStream } from './rangeRead'

const SIZE = 1000
const FILE = new Uint8Array(SIZE).map((_, i) => i % 251)

type Script = (start: number, end: number, call: number) => Response | Promise<Response>

function body(start: number, end: number, cut?: number): Response {
  const slice = FILE.subarray(start, cut === undefined ? end + 1 : Math.min(end + 1, start + cut))
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      // Two chunks so the resume logic sees a partial delivery.
      const half = Math.floor(slice.byteLength / 2)
      if (half > 0) c.enqueue(slice.subarray(0, half))
      if (slice.byteLength - half > 0) c.enqueue(slice.subarray(half))
      c.close()
    },
  })
  return new Response(stream, {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${SIZE}` },
  })
}

let calls: { start: number; end: number }[]
function install(script: Script) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const range = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!
    const start = Number(range[1]); const end = Number(range[2])
    calls.push({ start, end })
    const signal = init.signal as AbortSignal
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    return script(start, end, calls.length)
  }))
}

const opts = (gate = new ReadGate()) => ({ url: () => 'http://x/f', size: SIZE, gate, maxAttempts: 3 })

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('rangeBytes', () => {
  it('delivers exactly the requested bytes', async () => {
    install((s, e) => body(s, e))
    expect(await rangeBytes(opts(), 10, 60)).toEqual(FILE.subarray(10, 60))
    expect(calls).toEqual([{ start: 10, end: 59 }])
  })

  it('resumes from its byte counter when a body ends early', async () => {
    install((s, e, n) => (n === 1 ? body(s, e, 20) : body(s, e)))
    expect(await rangeBytes(opts(), 0, 100)).toEqual(FILE.subarray(0, 100))
    expect(calls).toEqual([{ start: 0, end: 99 }, { start: 20, end: 99 }])
  })

  it('walks an honest cap across requests', async () => {
    install((s, e) => body(s, Math.min(e, s + 29)))
    expect(await rangeBytes(opts(), 0, 100)).toEqual(FILE.subarray(0, 100))
    expect(calls.map((c) => c.start)).toEqual([0, 30, 60, 90])
  })

  it('retries a 5xx with backoff and does not throw', async () => {
    install((s, e, n) => (n < 3 ? new Response('', { status: 503 }) : body(s, e)))
    expect(await rangeBytes(opts(), 0, 50)).toEqual(FILE.subarray(0, 50))
    expect(calls).toHaveLength(3)
  })

  it('retries a network error', async () => {
    install((s, e, n) => (n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : body(s, e)))
    expect(await rangeBytes(opts(), 0, 50)).toEqual(FILE.subarray(0, 50))
  })

  it('gives up after the attempt budget with nothing delivered', async () => {
    install(() => new Response('', { status: 503 }))
    await expect(rangeBytes(opts(), 0, 50)).rejects.toBeInstanceOf(ReadUnreachableError)
    expect(calls).toHaveLength(3)
  })

  it('progress resets the attempt budget', async () => {
    let served = 0
    install((s, e) => {
      served += 1
      // Fail twice between every 10 delivered bytes; never three in a row.
      if (served % 3 !== 0) return new Response('', { status: 503 })
      return body(s, Math.min(e, s + 9))
    })
    expect(await rangeBytes(opts(), 0, 40)).toEqual(FILE.subarray(0, 40))
  })

  it('treats 404 as terminal', async () => {
    install(() => new Response('', { status: 404 }))
    await expect(rangeBytes(opts(), 0, 50)).rejects.toBeInstanceOf(ReadFailedError)
    expect(calls).toHaveLength(1)
  })

  it('refreshes once on 401 then continues', async () => {
    install((s, e, n) => (n === 1 ? new Response('', { status: 401 }) : body(s, e)))
    const refresh = vi.fn(async () => true)
    expect(await rangeBytes({ ...opts(), refresh }, 0, 50)).toEqual(FILE.subarray(0, 50))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a second 401 after a refresh is terminal', async () => {
    install(() => new Response('', { status: 401 }))
    const refresh = vi.fn(async () => true)
    await expect(rangeBytes({ ...opts(), refresh }, 0, 50)).rejects.toBeInstanceOf(ReadFailedError)
    expect(calls).toHaveLength(2)
  })

  it('refuses an origin that ignored Range', async () => {
    install(() => new Response(FILE, { status: 200 }))
    await expect(rangeBytes(opts(), 10, 50)).rejects.toBeInstanceOf(ReadFailedError)
  })

  it('clamps the end to the file size and answers empty past it', async () => {
    install((s, e) => body(s, e))
    expect(await rangeBytes(opts(), 990, 2000)).toEqual(FILE.subarray(990))
    expect(calls).toEqual([{ start: 990, end: 999 }])
    expect(await rangeBytes(opts(), 1000, 2000)).toHaveLength(0)
  })
})

describe('abort', () => {
  it('a gate abort rejects the read in flight and later reads start clean', async () => {
    const gate = new ReadGate()
    let release: () => void = () => {}
    install((s, e, n) => (n === 1
      ? new Promise<Response>((resolve) => { release = () => resolve(body(s, e)) })
      : body(s, e)))
    const first = rangeBytes(opts(gate), 0, 50)
    await Promise.resolve()
    gate.abort()
    release()
    await expect(first).rejects.toBeInstanceOf(ReadAbortedError)
    expect(await rangeBytes(opts(gate), 0, 50)).toEqual(FILE.subarray(0, 50))
  })

  it('an abort during backoff rejects promptly', async () => {
    const gate = new ReadGate()
    install(() => new Response('', { status: 503 }))
    const read = rangeBytes(opts(gate), 0, 50)
    await vi.advanceTimersByTimeAsync(10)
    gate.abort()
    await expect(read).rejects.toBeInstanceOf(ReadAbortedError)
  })

  it('a closed gate refuses new reads', async () => {
    const gate = new ReadGate()
    gate.close()
    install((s, e) => body(s, e))
    await expect(rangeBytes(opts(gate), 0, 50)).rejects.toBeInstanceOf(ReadAbortedError)
    expect(calls).toHaveLength(0)
  })

  it('cancelling the stream aborts the request', async () => {
    const gate = new ReadGate()
    let seen: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return body(0, 99)
    }))
    const stream = rangeStream(opts(gate), 0, 100)
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    expect(seen!.aborted).toBe(true)
  })
})
