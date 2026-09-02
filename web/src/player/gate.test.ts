import { describe, expect, it } from 'vitest'
import { GATE_BASE_SEC, GATE_FLOOR_SEC, GATE_OPEN_SEC, gateSecondsFor } from './gate'

describe('gateSecondsFor', () => {
  const later = { sealed: false, gatedStart: false, opening: false }
  it('asks for the base with no region map', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, ...later })).toBe(GATE_BASE_SEC)
  })
  it('never waits for media the host has not published', () => {
    expect(gateSecondsFor({ producedEdgeSec: 106, currentTime: 100, ...later })).toBe(5.5)
    expect(gateSecondsFor({ producedEdgeSec: 130, currentTime: 100, ...later })).toBe(GATE_BASE_SEC)
  })
  it('never asks for less than the server does', () => {
    expect(gateSecondsFor({ producedEdgeSec: 101, currentTime: 100, ...later })).toBe(GATE_FLOOR_SEC)
  })
  it('takes the floor for a sealed region and for a gated start', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, ...later, sealed: true })).toBe(GATE_FLOOR_SEC)
    expect(gateSecondsFor({ producedEdgeSec: 200, currentTime: 0, ...later, gatedStart: true })).toBe(GATE_FLOOR_SEC)
  })
  it('the opening asks for thirty seconds however thin the published edge is', () => {
    expect(GATE_OPEN_SEC).toBe(30)
    expect(gateSecondsFor({ producedEdgeSec: 106, currentTime: 100, ...later, opening: true })).toBe(GATE_OPEN_SEC)
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, ...later, opening: true })).toBe(GATE_OPEN_SEC)
  })
})
