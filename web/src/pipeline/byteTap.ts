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

/** Held for the scan while the remux runs ahead of it. */
const DEFAULT_BUFFER_BYTES = 64 * 1024 * 1024
/** How long a pull waits on the remux before deciding it went elsewhere. */
const DEFAULT_IDLE_MS = 3_000
/** Most one pull hands over, so the parser gets bytes rather than a backlog. */
const MAX_PULL_BYTES = 8 * 1024 * 1024

export class ByteTap {
  private at = 0
  private pending = new Map<number, Uint8Array>()
  private buffered = 0
  private waiter: ((woken: boolean) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private done = false
  // The furthest byte the remux has been seen reading. When it is far beyond
  // the cursor there is nothing to wait for — the scan is behind a gap it has
  // to cross on its own — and when the cursor catches back up, riding along
  // resumes by itself.
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

  /** Bytes the remux just read, at their absolute offset in the file. */
  offer(offset: number, bytes: Uint8Array): void {
    if (this.done || bytes.length === 0) return
    this.furthest = Math.max(this.furthest, offset + bytes.length)
    if (offset + bytes.length <= this.at) return
    if (offset < this.at) {
      bytes = bytes.subarray(this.at - offset)
      offset = this.at
    }
    // Beyond what the budget could hold anyway. The remux reads the container's
    // index at the end of the file, and after a seek it reads a region the scan
    // will not reach for gigabytes; buffering either would squat the budget
    // against bytes the scan wants next.
    if (offset > this.at + this.bufferBytes) return
    // Every reason to refuse is weighed before anything is let go: dropping
    // what is held for a replacement that is then refused would leave a hole
    // where buffered bytes used to be, and the scan would go and fetch them
    // from the origin again.
    const held = this.pending.get(offset)
    if (held && held.length >= bytes.length) return
    if (offset !== this.at && this.buffered - (held?.length ?? 0) + bytes.length > this.bufferBytes) return
    if (held) {
      this.buffered -= held.length
      this.pending.delete(offset)
    }
    // The caller keeps writing into its own buffer, and the chunk may sit
    // here across many reads, so what is held has to be ours.
    this.pending.set(offset, bytes.slice())
    this.buffered += bytes.length
    if (offset === this.at) this.wake(true)
  }

  /**
   * Contiguous bytes at the cursor, or null when the caller should fetch the
   * next slice itself — the remux is elsewhere, or through.
   */
  async pull(): Promise<Uint8Array | null> {
    for (;;) {
      const out = this.drain()
      if (out) return out
      if (this.done) return null
      // The remux is somewhere the cursor will not reach for a while: this is
      // a gap, and waiting for it to be filled by someone who has moved past
      // costs three seconds per slice and fills none of it. Cross it, and the
      // moment the cursor is back within reach the wait is worth taking again.
      if (this.furthest > this.at + this.bufferBytes) return null
      if (!(await this.idle())) return null
    }
  }

  /** The caller fetched these bytes at the cursor itself. */
  fill(bytes: Uint8Array): void {
    this.at += bytes.length
    this.prune()
  }

  /** No further offers will come; every pull from now on returns null. */
  close(): void {
    this.done = true
    this.pending.clear()
    this.buffered = 0
    this.wake(false)
  }

  // Everything buffered from the cursor forward, up to one pull's worth.
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

  // The buffered bytes starting at `pos`. Usually an exact hit; a chunk that
  // straddles `pos` because an earlier read overlapped it is worth the scan.
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

  // Resolves true when a chunk landed on the cursor, false when the wait ran
  // out or the tap closed.
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
  // Read and re-enqueue by hand rather than pipeThrough: piping keeps a
  // promise of its own that nobody awaits, and a seek — which rejects every
  // read in flight — would surface as an unhandled rejection on the page.
  // Here the only path an error takes is the one the consumer is already
  // reading.
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
