import { describe, expect, it } from 'vitest'
import { GATE_BASE_SEC, GATE_FLOOR_SEC, gateSecondsFor } from './gate'

describe('gateSecondsFor', () => {
  it('asks for the base with no region map', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, sealed: false, gatedStart: false })).toBe(GATE_BASE_SEC)
  })
  it('asks for the whole base however thin the published edge is', () => {
    // The host keeps producing ahead; the wait ends with the buffer built,
    // not with whatever had been published when the viewer arrived.
    expect(gateSecondsFor({ producedEdgeSec: 106, currentTime: 100, sealed: false, gatedStart: false })).toBe(GATE_BASE_SEC)
    expect(gateSecondsFor({ producedEdgeSec: 130, currentTime: 100, sealed: false, gatedStart: false })).toBe(GATE_BASE_SEC)
  })
  it('asks for thirty seconds', () => {
    expect(GATE_BASE_SEC).toBe(30)
    expect(GATE_BASE_SEC).toBeGreaterThan(GATE_FLOOR_SEC)
  })
  it('takes the floor for a sealed region and for a gated start', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, sealed: true, gatedStart: false })).toBe(GATE_FLOOR_SEC)
    expect(gateSecondsFor({ producedEdgeSec: 200, currentTime: 0, sealed: false, gatedStart: true })).toBe(GATE_FLOOR_SEC)
  })
})
