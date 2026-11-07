import { describe, expect, it } from 'vitest'
import { GATE_BASE_SEC, GATE_FLOOR_SEC, gateSecondsFor } from './gate'

describe('gateSecondsFor', () => {
  const wait = { sealed: false, gatedStart: false }
  it('asks for the base with no region map', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, ...wait })).toBe(GATE_BASE_SEC)
  })
  it('never waits for media the host has not published', () => {
    expect(gateSecondsFor({ producedEdgeSec: 106, currentTime: 100, ...wait })).toBe(5.5)
    expect(gateSecondsFor({ producedEdgeSec: 130, currentTime: 100, ...wait })).toBe(GATE_BASE_SEC)
  })
  it('never asks for less than the server does', () => {
    expect(gateSecondsFor({ producedEdgeSec: 101, currentTime: 100, ...wait })).toBe(GATE_FLOOR_SEC)
  })
  it('takes the floor for a sealed region and for a gated start', () => {
    expect(gateSecondsFor({ producedEdgeSec: null, currentTime: 0, ...wait, sealed: true })).toBe(GATE_FLOOR_SEC)
    expect(gateSecondsFor({ producedEdgeSec: 200, currentTime: 0, ...wait, gatedStart: true })).toBe(GATE_FLOOR_SEC)
  })
})
