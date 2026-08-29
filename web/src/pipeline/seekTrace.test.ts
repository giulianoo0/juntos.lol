import { describe, expect, it } from 'vitest'
import { createSeekTracer, formatSeekTrace } from './seekTrace'

describe('seek tracer', () => {
  it('stamps marks relative to the seek and closes into the sink', () => {
    let clock = 1000
    const traces: ReturnType<typeof tracer.end>[] = []
    const tracer = createSeekTracer((trace) => traces.push(trace), () => clock)
    tracer.mark('nothing open yet')
    tracer.begin(720_000)
    clock = 1250
    tracer.mark('canceled')
    clock = 1600
    tracer.mark('keyframe', -2340)
    tracer.mark('keyframe', 99)
    expect(tracer.has('keyframe')).toBe(true)
    expect(tracer.has('publishOk')).toBe(false)
    tracer.end()
    expect(tracer.has('keyframe')).toBe(false)
    expect(traces).toHaveLength(1)
    expect(traces[0]).toEqual({ seq: 1, targetMs: 720_000, marks: { canceled: 250, keyframe: 600 }, notes: { keyframe: -2340 } })
    expect(formatSeekTrace('host', traces[0]!)).toBe('[seek-trace] host #1 target=720000ms canceled=250 keyframe=600(-2340)')
  })

  it('closes an unfinished trace when the next seek begins', () => {
    const traces: unknown[] = []
    const tracer = createSeekTracer((trace) => traces.push(trace), () => 0)
    tracer.begin(1)
    tracer.begin(2)
    expect(traces).toHaveLength(1)
    expect(tracer.open()).toBe(true)
    tracer.end()
    expect(traces).toHaveLength(2)
    expect(tracer.end()).toBeNull()
  })
})
