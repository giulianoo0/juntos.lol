/**
 * Where the time of a cold seek goes.
 *
 * A seek passes through a dozen hands — the reads aborted, the old
 * conversion canceled, the keyframe found, the first segment muxed, put,
 * published, seen, buffered, shown — and until now none of them left a
 * timestamp. One trace per seek, marks named for the hand, all relative to
 * the moment the seek was issued; closed into a single log line a person or
 * a rig can read.
 *
 * No clock but the monotonic one, no network, no storage: the cost of a mark
 * is a map write.
 */
export interface SeekTrace {
  /** Which seek this is, counting from one within the tracer's life. */
  seq: number
  /** Where the seek was going, in media milliseconds. */
  targetMs: number
  /** Milliseconds since the seek was issued, by mark name, in order. */
  marks: Record<string, number>
  /** Free-form facts a mark wants to leave beside its time. */
  notes: Record<string, number | string>
}

export interface SeekTracer {
  /** Starts a trace; a trace still open is closed first, unfinished. */
  begin(targetMs: number): SeekTrace
  /** Stamps the open trace, if any. A name stamped twice keeps the first. */
  mark(name: string, note?: number | string): void
  /** Whether a trace is open. */
  open(): boolean
  /** Whether the open trace already carries this mark. */
  has(name: string): boolean
  /** Closes the open trace and hands it to the sink. */
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

/** The one line a trace becomes in a console. */
export function formatSeekTrace(side: string, trace: SeekTrace): string {
  const marks = Object.entries(trace.marks).map(([name, ms]) => {
    const note = trace.notes[name]
    return `${name}=${ms}${note !== undefined ? `(${note})` : ''}`
  }).join(' ')
  return `[seek-trace] ${side} #${trace.seq} target=${trace.targetMs}ms ${marks}`
}
