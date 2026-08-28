import { describe, expect, it } from 'vitest'
import { FORGIVE_MS, MAX_RECOVERIES, nextRecovery } from './recovery'

const fresh = { spent: 0, atMs: 0 }

describe('nextRecovery', () => {
  it('allows the budget, then gives up', () => {
    let state = nextRecovery(fresh, 1_000)!
    expect(state.spent).toBe(1)
    state = nextRecovery(state, 2_000)!
    expect(state.spent).toBe(MAX_RECOVERIES)
    expect(nextRecovery(state, 3_000)).toBeNull()
  })

  it('forgives a budget spent long ago', () => {
    // The case that stranded a room: the player no longer rebuilds itself
    // every couple of seconds, so a count kept for life meant the second
    // rough patch of an evening was fatal.
    const spent = { spent: MAX_RECOVERIES, atMs: 1_000 }
    expect(nextRecovery(spent, 1_000 + FORGIVE_MS - 1)).toBeNull()
    const after = nextRecovery(spent, 1_000 + FORGIVE_MS)
    expect(after).not.toBeNull()
    expect(after!.spent).toBe(1)
  })

  it('still stops a player thrashing in tight succession', () => {
    let state: ReturnType<typeof nextRecovery> = fresh
    let allowed = 0
    for (let at = 0; at < 10_000; at += 500) {
      state = nextRecovery(state!, at)
      if (state === null) break
      allowed += 1
    }
    expect(allowed).toBe(MAX_RECOVERIES)
  })
})
