import { describe, expect, it, vi } from 'vitest'
import { PluginRunError, runPlugin, type SpawnOptions, type WorkerReply, type WorkerRequest } from './runtime'

/** A stand-in worker: the test drives it by calling `emit`. */
function fakeWorker() {
  let onMessage: ((message: WorkerRequest) => void) | null = null
  const replies: WorkerReply[] = []
  const terminated = { value: false }
  const spawn = (options: SpawnOptions) => {
    onMessage = options.onMessage
    return {
      post: (reply: WorkerReply) => replies.push(reply),
      terminate: () => { terminated.value = true },
    }
  }
  return { spawn, replies, terminated, emit: (message: WorkerRequest) => onMessage?.(message) }
}

const base = { hosts: ['a.com'], selfOrigin: 'https://ss.giuli.dev' }

describe('runPlugin', () => {
  it('resolves with whatever the plugin reported', async () => {
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn() })
    worker.emit({ kind: 'done', streams: [{ infoHash: 'abc' }] })
    await expect(promise).resolves.toEqual([{ infoHash: 'abc' }])
    expect(worker.terminated.value).toBe(true)
  })

  it('performs an allowed fetch and hands the body back', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: '{"streams":[]}' })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(fetchUrl).toHaveBeenCalledOnce()
    expect(worker.replies[0]).toEqual({ id: 1, ok: true, status: 200, text: '{"streams":[]}' })
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('answers a denied fetch without performing it', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 7, url: 'https://evil.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(fetchUrl).not.toHaveBeenCalled()
    expect(worker.replies[0]).toMatchObject({ id: 7, ok: false, status: 0 })
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('kills a plugin that goes over the request ceiling', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: '' })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl, maxRequests: 2 })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/1' })
    worker.emit({ kind: 'fetch', id: 2, url: 'https://a.com/2' })
    worker.emit({ kind: 'fetch', id: 3, url: 'https://a.com/3' })
    await expect(promise).rejects.toMatchObject({ reason: 'too-many-requests' })
    expect(worker.terminated.value).toBe(true)
  })

  it('counts a denied request against the ceiling too', async () => {
    // Otherwise a plugin gets an unlimited budget for requests the policy
    // refuses, which is a free loop that keeps the tab busy.
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn(), maxRequests: 2 })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://evil.com/1' })
    worker.emit({ kind: 'fetch', id: 2, url: 'https://evil.com/2' })
    worker.emit({ kind: 'fetch', id: 3, url: 'https://evil.com/3' })
    await expect(promise).rejects.toMatchObject({ reason: 'too-many-requests' })
  })

  it('kills a plugin that runs past its time budget', async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn(), timeoutMs: 1_000 })
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    expect(worker.terminated.value).toBe(true)
    vi.useRealTimers()
  })

  it('refuses a body that a declared host redirected in from somewhere else', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: 'secret', finalUrl: 'https://evil.com/x',
    })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 4, url: 'https://a.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(worker.replies[0]).toMatchObject({ id: 4, ok: false, status: 0 })
    expect(worker.replies[0].text).not.toContain('secret')
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('lets a redirect within the allowlist through', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: 'body', finalUrl: 'https://a.com/elsewhere',
    })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 5, url: 'https://a.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(worker.replies[0]).toEqual({ id: 5, ok: true, status: 200, text: 'body' })
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('answers a request that arrived before spawn returned', async () => {
    // A spawn that drives onMessage synchronously used to post into a null
    // handle and lose the reply for ever.
    const replies: WorkerReply[] = []
    const driver: { emit(message: WorkerRequest): void } = { emit: () => undefined }
    const spawn = (options: SpawnOptions) => {
      driver.emit = options.onMessage
      options.onMessage({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
      return { post: (reply: WorkerReply) => replies.push(reply), terminate: () => undefined }
    }
    const promise = runPlugin({
      ...base,
      spawn,
      fetchUrl: vi.fn().mockResolvedValue({ ok: true, status: 200, text: 'x' }),
    })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    driver.emit({ kind: 'done', streams: [] })
    await expect(promise).resolves.toEqual([])
  })

  it('terminates a worker whose spawn finished the run before returning', async () => {
    const terminated = { value: false }
    const spawn = (options: SpawnOptions) => {
      options.onMessage({ kind: 'done', streams: ['early'] })
      return { post: () => undefined, terminate: () => { terminated.value = true } }
    }
    await expect(runPlugin({ ...base, spawn, fetchUrl: vi.fn() })).resolves.toEqual(['early'])
    expect(terminated.value).toBe(true)
  })

  it('aborts requests still in flight when the plugin is killed', async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    const seen: { signal: AbortSignal | null } = { signal: null }
    const fetchUrl = vi.fn((_url: URL, signal: AbortSignal) => {
      seen.signal = signal
      return new Promise<never>(() => undefined)
    })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl, timeoutMs: 1_000 })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    expect(seen.signal?.aborted).toBe(true)
    vi.useRealTimers()
  })

  it('ends when the caller aborts, without waiting out the budget', async () => {
    const worker = fakeWorker()
    const abort = new AbortController()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn(), signal: abort.signal })
    abort.abort()
    await expect(promise).rejects.toMatchObject({ reason: 'aborted' })
    expect(worker.terminated.value).toBe(true)
  })

  it('does not even spawn when the signal is already aborted', async () => {
    const spawn = vi.fn()
    await expect(runPlugin({ ...base, spawn, fetchUrl: vi.fn(), signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ reason: 'aborted' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('surfaces an error the plugin threw', async () => {
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn() })
    worker.emit({ kind: 'error', message: 'boom' })
    await expect(promise).rejects.toBeInstanceOf(PluginRunError)
    await expect(promise).rejects.toMatchObject({ reason: 'plugin-error', message: expect.stringContaining('boom') })
  })
})
