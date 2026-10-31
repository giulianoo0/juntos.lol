/**
 * Where the time of a cold seek goes: one trace per seek, a mark per hand
 * (abort, cancel, keyframe, mux, put, publish, buffer, shown) relative to when
 * it was issued, closed into one log line. Monotonic clock only; a mark is a map write.
 */
export interface SeekTrace {
  seq: number
  targetMs: number
  marks: Record<string, number>
  notes: Record<string, number | string>
}

export interface SeekTracer {
  /** Starts a trace; a trace still open is closed first, unfinished. */
  begin(targetMs: number): SeekTrace
  /** Stamps the open trace, if any. A name stamped twice keeps the first. */
  mark(name: string, note?: number | string): void
  open(): boolean
  has(name: string): boolean
  end(): SeekTrace | null
}

export function createSeekTracer(
  sink: (trace: SeekTrace) => void,
  now: () => number = () => performance.now(),
): SeekTracer {
  let current: { trace: SeekTrace; startedAt: number } | null = null
  let seq = 0
  const end = (): SeekTrace | null => {
    if (!current) return null
    const { trace } = current
    current = null
    sink(trace)
    return trace
  }
  return {
    begin(targetMs) {
      end()
      seq += 1
      const trace: SeekTrace = { seq, targetMs, marks: {}, notes: {} }
      current = { trace, startedAt: now() }
      return trace
    },
    mark(name, note) {
      if (!current) return
      const { trace, startedAt } = current
      if (name in trace.marks) return
      trace.marks[name] = Math.round(now() - startedAt)
      if (note !== undefined) trace.notes[name] = note
    },
    open: () => current !== null,
    has: (name) => current !== null && name in current.trace.marks,
    end,
  }
}

export function formatSeekTrace(side: string, trace: SeekTrace): string {
  const marks = Object.entries(trace.marks).map(([name, ms]) => {
    const note = trace.notes[name]
    return `${name}=${ms}${note !== undefined ? `(${note})` : ''}`
  }).join(' ')
  return `[seek-trace] ${side} #${trace.seq} target=${trace.targetMs}ms ${marks}`
}
