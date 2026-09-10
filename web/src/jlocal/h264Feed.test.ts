import { describe, expect, it } from 'vitest'
import { FrameParser, codecFromAnnexB, decodeInterleavedS16 } from './h264Feed'

function packet(pts: number, keyframe: boolean, payload: number[]): Uint8Array {
  const out = new Uint8Array(13 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  view.setBigUint64(4, BigInt(pts))
  view.setUint8(12, keyframe ? 1 : 0)
  out.set(payload, 13)
  return out
}

describe('FrameParser', () => {
  it('reassembles frames across chunk boundaries and rebases time to the first frame', () => {
    const parser = new FrameParser()
    const a = packet(5_000_000, true, [0, 0, 0, 1, 0x65, 1, 2, 3])
    const b = packet(5_016_667, false, [0, 0, 0, 1, 0x41, 9])
    const all = new Uint8Array(a.length + b.length)
    all.set(a, 0)
    all.set(b, a.length)
    const first = parser.push(all.slice(0, 7))
    expect(first).toEqual([])
    const rest = parser.push(all.slice(7))
    expect(rest.map((frame) => [frame.timestamp, frame.keyframe, frame.data.length])).toEqual([
      [0, true, 8],
      [16_667, false, 6],
    ])
  })
})

describe('codecFromAnnexB', () => {
  it('reads profile, constraints and level from the SPS', () => {
    const sps = new Uint8Array([0, 0, 0, 1, 0x27, 0x64, 0x00, 0x34, 0xac])
    expect(codecFromAnnexB(sps)).toBe('avc1.640034')
  })

  it('is null without an SPS', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x65, 0x88]))).toBeNull()
  })
})

describe('decodeInterleavedS16', () => {
  it('splits little-endian stereo samples into planar floats', () => {
    const frame = new Uint8Array(8)
    const view = new DataView(frame.buffer)
    view.setInt16(0, 16384, true)
    view.setInt16(2, -32768, true)
    view.setInt16(4, 0, true)
    view.setInt16(6, 32767, true)
    const left = new Float32Array(2)
    const right = new Float32Array(2)
    const buffer = { length: 2, getChannelData: (channel: number) => (channel === 0 ? left : right) } as unknown as AudioBuffer
    decodeInterleavedS16(frame, buffer)
    expect(Array.from(left)).toEqual([0.5, 0])
    expect(right[0]).toBe(-1)
    expect(right[1]).toBeCloseTo(1, 4)
  })
})
