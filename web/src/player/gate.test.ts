import { describe, expect, it } from 'vitest'
import { GATE_BASE_SEC, GATE_FLOOR_SEC, gateSecondsFor } from './gate'

describe('gateSecondsFor', () => {
  it('asks for the base with no region map', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, sealed: false, gatedStart: false })).toBe(GATE_BASE_SEC)
  })
  it('never waits for media the host has not published', () => {
    // The region has 6 s produced past the playhead: waiting for 10 would be
    // waiting for the uplink.
    expect(gateSecondsFor({ producedEdgeSec: 106, currentTime: 100, sealed: false, gatedStart: false })).toBe(5.5)
    expect(gateSecondsFor({ producedEdgeSec: 130, currentTime: 100, sealed: false, gatedStart: false })).toBe(GATE_BASE_SEC)
  })
  it('never asks for less than the server does', () => {
    expect(gateSecondsFor({ producedEdgeSec: 101, currentTime: 100, sealed: false, gatedStart: false })).toBe(GATE_FLOOR_SEC)
  })
  it('takes the floor for a sealed region and for a gated start', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, sealed: true, gatedStart: false })).toBe(GATE_FLOOR_SEC)
    expect(gateSecondsFor({ producedEdgeSec: 200, currentTime: 0, sealed: false, gatedStart: true })).toBe(GATE_FLOOR_SEC)
  })
})
