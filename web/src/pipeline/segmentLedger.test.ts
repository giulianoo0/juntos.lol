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
