import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerGrant } from '../torrent'
import { workerInput } from './mediaInput'

const grant: WorkerGrant = {
  jobId: 'j1',
  readBase: 'https://w1.example',
  ticket: 't1',
  expiresAt: '',
  name: 'film.mkv',
  size: 4_000_000_000,
  fileIndex: 0,
}

function hintedGenerations(fetchMock: ReturnType<typeof vi.fn>): number[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/v1/hint/'))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { gen: number }).gen)
}

describe('workerInput generations', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.restoreAllMocks())

  it('never restarts a generation a previous input already used', () => {
    const first = workerInput(grant)
    first.prefetchAt?.(0)
    first.abortReads()
    first.prefetchAt?.(2_000_000_000)
    const before = hintedGenerations(fetchMock)

    const second = workerInput(grant)
    second.prefetchAt?.(0)
    const after = hintedGenerations(fetchMock).slice(before.length)

    expect(before).toHaveLength(2)
    expect(after).toHaveLength(1)
    expect(after[0]).toBeGreaterThan(Math.max(...before))
  })

  it('still moves forward on every seek within one input', () => {
    const input = workerInput(grant)
    input.prefetchAt?.(0)
    input.abortReads()
    input.prefetchAt?.(2_000_000_000)
    const [first, second] = hintedGenerations(fetchMock)
    expect(second).toBeGreaterThan(first)
  })
})
