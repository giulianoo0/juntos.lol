import { describe, expect, it } from 'vitest'
import { SubscriptionPool, type PooledWatch, type WatchStatus } from './subscriptions'

class FakeWatch implements PooledWatch {
  closed = false
  private listeners = new Set<(status: WatchStatus) => void>()
  private current: WatchStatus
  key: string
  constructor(key: string, status: WatchStatus = 'offline') { this.key = key; this.current = status }
  status = {
    peek: () => this.current,
    subscribe: (listener: (status: WatchStatus) => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  set(status: WatchStatus) {
    this.current = status
    for (const listener of this.listeners) listener(status)
  }
  close() { this.closed = true }
}

function harness() {
  let now = 0
  const opened: FakeWatch[] = []
  const pending: Array<(watch: FakeWatch) => void> = []
  const statuses: Record<string, WatchStatus | undefined> = {}
  const pool = new SubscriptionPool<FakeWatch>({
    open: (key) => new Promise<FakeWatch>((resolve) => pending.push((watch) => { opened.push(watch); resolve(watch) })).then((watch) => { watch.key = key; return watch }),
    onStatus: (key, status) => { if (status) statuses[key] = status; else delete statuses[key] },
    now: () => now,
  })
  const settle = async (status: WatchStatus = 'offline') => {
    while (pending.length) pending.shift()!(new FakeWatch('', status))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  return { pool, opened, statuses, settle, advance: (ms: number) => { now += ms }, pendingCount: () => pending.length }
}

describe('SubscriptionPool', () => {
  it('opens one subscription per wanted key and reports its status', async () => {
    const h = harness()
    h.pool.want('m2')
    h.pool.want('m2')
    expect(h.pendingCount()).toBe(1)
    await h.settle('loading')
    expect(h.statuses.m2).toBe('loading')
    h.opened[0].set('live')
    expect(h.statuses.m2).toBe('live')
    expect(h.pool.get('m2')).toBe(h.opened[0])
  })

  it('retries a subscription the relay turned away, and leaves a live one alone', async () => {
    const h = harness()
    h.pool.want('m2')
    h.pool.want('m3')
    await h.settle('offline')
    h.opened[1].set('live')
    h.advance(4_000)
    h.pool.tick()
    expect(h.opened[0].closed).toBe(true)
    expect(h.opened[1].closed).toBe(false)
    await h.settle('live')
    expect(h.pool.get('m2')).toBe(h.opened[2])
    expect(h.statuses.m2).toBe('live')
  })

  it('gives a subscription still loading its catalog much longer', async () => {
    const h = harness()
    h.pool.want('m2')
    await h.settle('loading')
    h.advance(4_000)
    h.pool.tick()
    expect(h.opened[0].closed).toBe(false)
    h.advance(11_000)
    h.pool.tick()
    expect(h.opened[0].closed).toBe(true)
  })

  it('closes a dropped key, including one whose open is still in flight', async () => {
    const h = harness()
    h.pool.want('m2')
    h.pool.drop('m2')
    await h.settle('live')
    expect(h.opened[0].closed).toBe(true)
    expect(h.pool.get('m2')).toBeNull()
    expect(h.statuses.m2).toBeUndefined()
  })

  it('reopens every key that has no subscription yet when asked', async () => {
    let ready = false
    const opened: string[] = []
    const pool = new SubscriptionPool<FakeWatch>({
      open: (key) => { if (!ready) return null; opened.push(key); return Promise.resolve(new FakeWatch(key, 'live')) },
      now: () => 0,
    })
    pool.want('m2')
    expect(opened).toEqual([])
    ready = true
    pool.refresh()
    expect(opened).toEqual(['m2'])
  })

  it('closes everything on close', async () => {
    const h = harness()
    h.pool.want('m2')
    await h.settle('live')
    h.pool.close()
    expect(h.opened[0].closed).toBe(true)
  })
})
