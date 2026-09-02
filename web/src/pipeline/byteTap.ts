/**
 * The remux and the embedded-subtitle scan want the same bytes: one demuxes
 * them, the other walks the EBML for text tracks. Read separately they cost
 * the origin twice, and on a remote worker "twice" is worse than it sounds —
 * `apply_window` gives every read cursor its own 256 MiB piece window, so the
 * scan's window competes with the playhead's for the same swarm, and the
 * cold wait a viewer sits through is roughly doubled.
 *
 * The tap makes the scan a passenger. Every chunk the remux reads is offered
 * here with its absolute offset; the scan pulls from a cursor and only ever
 * sees a contiguous stream, which is what a sequential EBML parser needs.
 * Bytes the remux never reads — the gap a seek leaves behind — the scan
 * fetches itself, so the parser is never handed a hole and never has to
 * resynchronise.
 */

const DEFAULT_BUFFER_BYTES = 64 * 1024 * 1024
const DEFAULT_IDLE_MS = 10_000
const MAX_PULL_BYTES = 8 * 1024 * 1024

export class ByteTap {
  private at = 0
  private pending = new Map<number, Uint8Array>()
  private buffered = 0
  private waiter: ((woken: boolean) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private done = false
  private furthest = 0

  private readonly bufferBytes: number
  private readonly idleMs: number

  constructor(bufferBytes = DEFAULT_BUFFER_BYTES, idleMs = DEFAULT_IDLE_MS) {
    this.bufferBytes = bufferBytes
    this.idleMs = idleMs
  }

  /** The next byte the scan has not seen. */
  get cursor(): number {
    return this.at
  }

  /** Reading within reach of the cursor, so the scan can ride along instead
   * of fetching the same bytes. False across a gap, and once closed. */
  get riding(): boolean {
    return !this.done && this.furthest <= this.at + this.bufferBytes
  }

  /** Bytes the remux just read, at their absolute offset in the file. */
  offer(offset: number, bytes: Uint8Array): void {
    if (this.done || bytes.length === 0) return
    this.furthest = Math.max(this.furthest, offset + bytes.length)
    if (offset + bytes.length <= this.at) return
    if (offset < this.at) {
      bytes = bytes.subarray(this.at - offset)
      offset = this.at
    }
    if (offset > this.at + this.bufferBytes) return
    const held = this.pending.get(offset)
    if (held && held.length >= bytes.length) return
    if (offset !== this.at && this.buffered - (held?.length ?? 0) + bytes.length > this.bufferBytes) return
    if (held) {
      this.buffered -= held.length
      this.pending.delete(offset)
    }
    this.pending.set(offset, bytes.slice())
    this.buffered += bytes.length
    if (offset === this.at) this.wake(true)
  }

  /** Contiguous bytes at the cursor, or null when the caller should fetch
   * the next slice itself — the remux is elsewhere, or through. */
  async pull(): Promise<Uint8Array | null> {
    for (;;) {
      const out = this.drain()
      if (out) return out
      if (this.done) return null
      if (this.furthest > this.at + this.bufferBytes) return null
      if (!(await this.idle())) return null
    }
  }

  /** The caller fetched these bytes at the cursor itself. */
  fill(bytes: Uint8Array): void {
    this.at += bytes.length
    this.prune()
  }

  close(): void {
    this.done = true
    this.pending.clear()
    this.buffered = 0
    this.wake(false)
  }

  private drain(): Uint8Array | null {
    const parts: Uint8Array[] = []
    let total = 0
    while (total < MAX_PULL_BYTES) {
      const next = this.takeAt(this.at)
      if (!next) break
      parts.push(next)
      total += next.length
      this.at += next.length
    }
    if (total === 0) return null
    this.prune()
    if (parts.length === 1) return parts[0]
    const joined = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    return joined
  }

  private takeAt(pos: number): Uint8Array | null {
    const exact = this.pending.get(pos)
    if (exact) {
      this.pending.delete(pos)
      this.buffered -= exact.length
      return exact
    }
    for (const [offset, bytes] of this.pending) {
      if (offset < pos && offset + bytes.length > pos) {
        this.pending.delete(offset)
        this.buffered -= bytes.length
        return bytes.subarray(pos - offset)
      }
    }
    return null
  }

  private prune(): void {
    for (const [offset, bytes] of this.pending) {
      if (offset + bytes.length <= this.at) {
        this.pending.delete(offset)
        this.buffered -= bytes.length
      }
    }
  }

  // Resolves true when a chunk landed on the cursor, false on timeout or close.
  private idle(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.waiter = resolve
      this.timer = setTimeout(() => this.wake(false), this.idleMs)
    })
  }

  private wake(woken: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const waiter = this.waiter
    this.waiter = null
    waiter?.(woken)
  }
}

/**
 * Passes a read through untouched while mirroring it into the tap. The
 * offsets are the read's own: the tap needs where in the file each chunk
 * came from, which only the caller of the range read knows.
 */
export function teeInto(
  tap: ByteTap,
  start: number,
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let offset = start
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      tap.offer(offset, value)
      offset += value.length
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
