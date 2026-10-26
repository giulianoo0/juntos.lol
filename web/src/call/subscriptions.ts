/**
 * Keeps one relay subscription per wanted key alive. The relay announces
 * nothing and keeps no history, so a subscription opened before its publisher
 * is up finds no track and stays silent forever: whatever the room says is
 * live is subscribed to, and one that never speaks is opened again.
 */
export type WatchStatus = 'offline' | 'loading' | 'live'

export interface PooledWatch {
  status: { peek(): WatchStatus; subscribe(listener: (status: WatchStatus) => void): () => void }
  close(): void
}

/** A subscription the relay turned away (no such broadcast yet) is tried again after this long. */
const RETRY_MS = 4_000
/**
 * One still waiting for its catalog is left alone much longer: a fresh QUIC
 * handshake plus a 4K keyframe on a busy link can take more than a few
 * seconds, and tearing that down every four was what kept tiles at
 * "connecting" for minutes.
 */
const LOADING_RETRY_MS = 15_000

interface Entry<W> {
  watch: W | null
  status: WatchStatus
  off?: () => void
  /** Bumped on every reopen so a late promise from an older one is dropped. */
  generation: number
  /** When the current subscription was opened; a silent one is retried on its own clock. */
  openedAt: number
  /** Set while a reopen waits out the gap; the next tick past it opens. */
  reopenAt?: number
}

export interface SubscriptionPoolOptions<W> {
  /** Opens the key's subscription, or returns null while it cannot yet (no relay). */
  open(key: string): Promise<W> | null
  /** Every status change, and `undefined` once the key is dropped. */
  onStatus?(key: string, status: WatchStatus | undefined, watch: W | null): void
  now?(): number
  /** How long a subscription the relay turned away gets before it is opened again. */
  retryMs?: number
  /** The same for one still waiting on its catalog. */
  loadingRetryMs?: number
  /**
   * How long to wait between throwing a subscription away and opening the
   * next. Several broadcasts on one connection need it: resubscribing while
   * the relay is still tearing the old subscription down starves the new one.
   */
  gapMs?: number
}

export class SubscriptionPool<W extends PooledWatch> {
  private readonly entries = new Map<string, Entry<W>>()
  private readonly now: () => number
  private readonly options: SubscriptionPoolOptions<W>

  constructor(options: SubscriptionPoolOptions<W>) {
    this.options = options
    this.now = options.now ?? (() => performance.now())
  }

  want(key: string): void {
    if (this.entries.has(key)) return
    const entry: Entry<W> = { watch: null, status: 'offline', generation: 0, openedAt: this.now() }
    this.entries.set(key, entry)
    this.open(key, entry)
  }

  drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    entry.generation += 1
    this.release(entry)
    this.options.onStatus?.(key, undefined, null)
  }

  get(key: string): W | null {
    return this.entries.get(key)?.watch ?? null
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  /** Opens every key still waiting for a subscription: the relay just became known. */
  refresh(): void {
    for (const [key, entry] of this.entries) {
      if (entry.watch || entry.reopenAt !== undefined) continue
      entry.generation += 1
      entry.openedAt = this.now()
      this.open(key, entry)
    }
  }

  /** Reopens every subscription that has not gone live in time; call it every second or so. */
  tick(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.reopenAt !== undefined) {
        if (now < entry.reopenAt) continue
        entry.reopenAt = undefined
        entry.openedAt = now
        this.open(key, entry)
        continue
      }
      if (entry.status === 'live') continue
      const retry = entry.status === 'loading' ? this.options.loadingRetryMs ?? LOADING_RETRY_MS : this.options.retryMs ?? RETRY_MS
      if (now - entry.openedAt < retry) continue
      this.reopen(key)
    }
  }

  /** Throws the key's subscription away and opens a fresh one. */
  reopen(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.release(entry)
    entry.status = 'offline'
    entry.generation += 1
    entry.openedAt = this.now()
    if (this.options.gapMs) {
      entry.reopenAt = entry.openedAt + this.options.gapMs
      return
    }
    this.open(key, entry)
  }

  close(): void {
    for (const key of [...this.entries.keys()]) this.drop(key)
  }

  private release(entry: Entry<W>) {
    entry.off?.()
    entry.off = undefined
    entry.watch?.close()
    entry.watch = null
  }

  private open(key: string, entry: Entry<W>) {
    const generation = entry.generation
    const pending = this.options.open(key)
    if (!pending) return
    void pending.then((watch) => {
      if (this.entries.get(key) !== entry || entry.generation !== generation) { watch.close(); return }
      entry.watch = watch
      const apply = (status: WatchStatus) => {
        entry.status = status
        this.options.onStatus?.(key, status, watch)
      }
      apply(watch.status.peek())
      entry.off = watch.status.subscribe(apply)
    }).catch(() => undefined)
  }
}
