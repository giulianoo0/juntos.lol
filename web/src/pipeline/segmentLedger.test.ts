// The ledger is what keeps a region's published span honest: the muxer runs
// far ahead of the uplink, so counting what it emitted claims media the
// bucket does not hold yet and the player cannot seek into.
import { describe, expect, it } from 'vitest'

import { createSegmentLedger } from './segmentLedger'

describe('segment ledger', () => {
  it('counts the segments the bucket confirmed, not the ones the muxer emitted', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteEmitted('cs_0_2.m4s')
    ledger.noteEmitted('cs_0_3.m4s')

    ledger.noteConfirmed(['cs_0_1.m4s'])

    expect(ledger.covered(0)).toBe(1)
  })

  it('is held down by the rendition that lags, not lifted by the one that leads', () => {
    const ledger = createSegmentLedger()
    for (const n of [1, 2, 3]) {
      ledger.noteEmitted(`cs_0_${n}.m4s`)
      ledger.noteEmitted(`cs_1_${n}.m4s`)
    }

    // The video playlist is three ahead; its audio rendition has one.
    ledger.noteConfirmed(['cs_0_1.m4s', 'cs_0_2.m4s', 'cs_0_3.m4s', 'cs_1_1.m4s'])

    expect(ledger.covered(0)).toBe(1)
  })

  it('keeps each region on its own books', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteEmitted('r1_cs_0_1.m4s')
    ledger.noteEmitted('r1_cs_0_2.m4s')

    ledger.noteConfirmed(['r1_cs_0_1.m4s', 'r1_cs_0_2.m4s'])

    expect(ledger.covered(0)).toBe(0)
    expect(ledger.covered(1)).toBe(2)
  })

  it('ignores names that are not segments', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteConfirmed(['cinit_0.mp4', 'master.m3u8', 'r0_master.m3u8', 'client_stream_0.m3u8'])

    expect(ledger.covered(0)).toBe(0)
  })

  it('reports a region settled only once every emitted segment is confirmed', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteEmitted('cs_0_2.m4s')

    ledger.noteConfirmed(['cs_0_1.m4s'])
    expect(ledger.settled(0)).toBe(false)

    ledger.noteConfirmed(['cs_0_2.m4s'])
    expect(ledger.settled(0)).toBe(true)
  })

  it('counts a name once however often the server vouches for it', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteEmitted('cs_0_2.m4s')

    ledger.noteConfirmed(['cs_0_1.m4s'])
    ledger.noteConfirmed(['cs_0_1.m4s'])

    expect(ledger.covered(0)).toBe(1)
  })

  it('does not call a region with nothing emitted settled', () => {
    const ledger = createSegmentLedger()

    expect(ledger.settled(0)).toBe(false)
  })
})

describe('contiguousIn', () => {
  it('answers how long the server can cut each rendition', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('r1_cs_0_1.m4s')
    ledger.noteEmitted('r1_cs_1_1.m4s')
    ledger.noteConfirmed(['r1_cs_0_1.m4s', 'r1_cs_0_2.m4s'])
    expect(ledger.contiguousIn(1, 0)).toBe(2)
    expect(ledger.contiguousIn(1, 1)).toBe(0)
    expect(ledger.contiguousIn(9, 0)).toBe(0)
  })

  it('stops at the first hole, however much landed after it', () => {
    // A seek drops uploads out of the middle of the queue, and the names that
    // confirm afterwards leave a gap the server cannot serve across.
    const ledger = createSegmentLedger()
    ledger.noteConfirmed(['r2_cs_0_1.m4s', 'r2_cs_0_2.m4s', 'r2_cs_0_4.m4s', 'r2_cs_0_5.m4s'])
    expect(ledger.contiguousIn(2, 0)).toBe(2)
  })

  it('is nothing when the first segment never landed', () => {
    const ledger = createSegmentLedger()
    ledger.noteConfirmed(['r3_cs_0_2.m4s', 'r3_cs_0_3.m4s'])
    expect(ledger.contiguousIn(3, 0)).toBe(0)
  })
})

describe('segment ledger durations', () => {
  it('measures a region by what its playlists declare, not by the target length', () => {
    const ledger = createSegmentLedger()
    for (const n of [1, 2, 3]) ledger.noteEmitted(`r1_cs_0_${n}.m4s`)
    // A source with a ten-second GOP closes every segment on its keyframe:
    // three "four-second" segments are really thirty seconds of media.
    ledger.noteDurations(1, 0, [10, 10, 10])
    ledger.noteConfirmed(['r1_cs_0_1.m4s', 'r1_cs_0_2.m4s', 'r1_cs_0_3.m4s'])

    expect(ledger.coveredMs(1, 4_000)).toBe(30_000)
  })

  it('falls back to the target length for a rendition whose playlist has not been seen', () => {
    const ledger = createSegmentLedger()
    ledger.noteEmitted('cs_0_1.m4s')
    ledger.noteEmitted('cs_0_2.m4s')
    ledger.noteConfirmed(['cs_0_1.m4s', 'cs_0_2.m4s'])

    expect(ledger.coveredMs(0, 4_000)).toBe(8_000)
  })

  it('stops at the first hole and at the shortest rendition', () => {
    const ledger = createSegmentLedger()
    for (const n of [1, 2, 3]) {
      ledger.noteEmitted(`cs_0_${n}.m4s`)
      ledger.noteEmitted(`cs_1_${n}.m4s`)
    }
    ledger.noteDurations(0, 0, [4, 4, 4])
    ledger.noteDurations(0, 1, [4.01, 3.99, 4])
    // Video landed 1 and 3 — the server cuts it at the hole. Audio landed all.
    ledger.noteConfirmed(['cs_0_1.m4s', 'cs_0_3.m4s', 'cs_1_1.m4s', 'cs_1_2.m4s', 'cs_1_3.m4s'])

    expect(ledger.coveredMs(0, 4_000)).toBe(4_000)
    expect(ledger.segmentStats(0)).toEqual({ count: 6, meanSec: 4, maxSec: 4.01 })
  })
})
