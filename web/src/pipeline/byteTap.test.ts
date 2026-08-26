import { describe, expect, it } from 'vitest'
import { ByteTap, teeInto } from './byteTap'

const bytes = (from: number, length: number) =>
  new Uint8Array(length).map((_, i) => (from + i) % 251)

// The idle wait is real time; every test that depends on it drives the
// clock, and the ones that do not never reach it.
const IDLE_MS = 50

describe('ByteTap', () => {
  it('hands over what the remux read, in order', async () => {
    const tap = new ByteTap()
    tap.offer(0, bytes(0, 10))
    tap.offer(10, bytes(10, 10))
    const out = await tap.pull()
    expect(out).toEqual(bytes(0, 20))
    expect(tap.cursor).toBe(20)
  })

  it('holds bytes read ahead of the cursor until the gap closes', async () => {
    const tap = new ByteTap(1024, IDLE_MS)
    tap.offer(10, bytes(10, 10))
    // Nothing at the cursor yet: the wait runs out and the caller is told to
    // fetch the gap itself.
    expect(await tap.pull()).toBeNull()
    tap.fill(bytes(0, 10))
    expect(await tap.pull()).toEqual(bytes(10, 10))
    expect(tap.cursor).toBe(20)
  })

  it('ignores bytes the cursor has already passed', async () => {
    const tap = new ByteTap()
    tap.offer(0, bytes(0, 10))
    await tap.pull()
    tap.offer(0, bytes(0, 10))
    tap.offer(5, bytes(5, 10))
    expect(await tap.pull()).toEqual(bytes(10, 5))
  })

  it('trims an offer that straddles the cursor', async () => {
    const tap = new ByteTap()
    tap.offer(0, bytes(0, 100))
    expect((await tap.pull())?.length).toBe(100)
    tap.offer(50, bytes(50, 100))
    expect(await tap.pull()).toEqual(bytes(100, 50))
  })

  it('takes a chunk buffered from before the cursor reached it', async () => {
    const tap = new ByteTap(1024, IDLE_MS)
    // Two overlapping reads: the second starts before the cursor will be.
    tap.offer(20, bytes(20, 40))
    tap.offer(0, bytes(0, 30))
    const out = await tap.pull()
    expect(out).toEqual(bytes(0, 60))
  })

  it('waits, then reports a gap, and keeps offering to wait', async () => {
    // Nothing has been read anywhere near the cursor, so there is no evidence
    // the remux has moved past — only that it is slow. Giving up on the tap
    // here for good would turn the scan back into a second full read.
    const tap = new ByteTap(1024, IDLE_MS)
    const started = Date.now()
    expect(await tap.pull()).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS - 5)
    tap.offer(0, bytes(0, 10))
    expect(await tap.pull()).toEqual(bytes(0, 10))
  })

  it('wakes a waiting pull the moment the cursor is fed', async () => {
    const tap = new ByteTap(1024, 10_000)
    const pulled = tap.pull()
    tap.offer(0, bytes(0, 10))
    expect(await pulled).toEqual(bytes(0, 10))
  })

  it('drops what does not fit rather than the bytes it is about to want', async () => {
    const tap = new ByteTap(150, IDLE_MS)
    tap.offer(50, bytes(50, 100))
    // Over budget now, so this one is let go.
    tap.offer(150, bytes(150, 100))
    // At the cursor, so it is taken whatever the budget says.
    tap.offer(0, bytes(0, 50))
    expect(await tap.pull()).toEqual(bytes(0, 150))
    expect(await tap.pull()).toBeNull()
  })

  it('ignores bytes further ahead than it could ever hold', async () => {
    // The remux reads the container's index at the end of the file, and after
    // a seek it reads a stretch the scan will not reach for gigabytes.
    // Buffering either squats the budget against what the scan wants next.
    const tap = new ByteTap(100, IDLE_MS)
    tap.offer(10_000, bytes(0, 50))
    tap.offer(0, bytes(0, 50))
    expect(await tap.pull()).toEqual(bytes(0, 50))
    tap.fill(bytes(0, 9_950))
    expect(await tap.pull()).toBeNull()
  })

  it('caps one pull so the parser gets bytes instead of a backlog', async () => {
    const tap = new ByteTap(32 * 1024 * 1024)
    for (let i = 0; i < 12; i += 1) tap.offer(i * 1024 * 1024, bytes(0, 1024 * 1024))
    expect((await tap.pull())?.length).toBe(8 * 1024 * 1024)
    expect((await tap.pull())?.length).toBe(4 * 1024 * 1024)
  })

  it('is closed for good once the input goes away', async () => {
    const tap = new ByteTap()
    tap.close()
    tap.offer(0, bytes(0, 10))
    expect(await tap.pull()).toBeNull()
  })
})

describe('teeInto', () => {
  it('passes every byte through and mirrors it at its own offset', async () => {
    const tap = new ByteTap()
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(100, 8))
        c.enqueue(bytes(108, 8))
        c.close()
      },
    })
    const reader = teeInto(tap, 100, source).getReader()
    const seen: number[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(...value)
    }
    expect(new Uint8Array(seen)).toEqual(bytes(100, 16))
    tap.fill(bytes(0, 100))
    expect(await tap.pull()).toEqual(bytes(100, 16))
  })

  it("lets the read's own failure through", async () => {
    const tap = new ByteTap()
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.error(new Error('gone')) },
    })
    const reader = teeInto(tap, 0, source).getReader()
    await expect(reader.read()).rejects.toThrow('gone')
  })
})

describe('ByteTap, when the remux runs far ahead', () => {
  const bytes2 = (from: number, length: number) =>
    new Uint8Array(length).map((_, i) => (from + i) % 251)

  it('crosses the gap itself and rides again once the cursor is back in reach', async () => {
    // Waiting on a reader that has moved on costs the idle wait per slice and
    // fills none of the gap; but giving up on the tap for good would make the
    // scan a second full read of the file, which is the whole point.
    const tap = new ByteTap(200, 50)
    tap.offer(10_000, bytes2(0, 10))
    const started = Date.now()
    expect(await tap.pull()).toBeNull()
    expect(Date.now() - started).toBeLessThan(40)

    tap.fill(bytes2(0, 9_900))
    tap.offer(9_900, bytes2(0, 20))
    expect((await tap.pull())?.length).toBe(20)
  })

  it('keeps what it holds when a replacement would not fit', async () => {
    const tap = new ByteTap(120, 50)
    tap.offer(20, bytes2(20, 100))
    // Same offset, larger, and past the budget: the held chunk must survive
    // rather than be let go for one that is then refused.
    tap.offer(20, bytes2(20, 200))
    tap.offer(0, bytes2(0, 20))
    expect((await tap.pull())?.length).toBe(120)
  })
})
