/**
 * What the player knows about the viewer's link that the room's reports carry
 * to the server: the throughput its fragment downloads actually reached and
 * the bitrate the media asks for. A stall with the first under the second is
 * the viewer's connection, not the room.
 */
export interface Transfer {
  start: number
  end: number
  bytes: number
}

const WINDOW_MS = 20_000
const MIN_BUSY_MS = 250

/**
 * Bytes over the time at least one download was running, in the window that
 * ends at `now`. Fetches overlap (the loader keeps a few in flight), so the
 * busy time is the union of their spans, not the sum.
 */
export function throughputKbps(transfers: readonly Transfer[], now: number, windowMs = WINDOW_MS): number {
  const from = now - windowMs
  const spans = transfers
    .filter((transfer) => transfer.end > from && transfer.end <= now)
    .map((transfer) => ({ start: Math.max(transfer.start, from), end: transfer.end, bytes: transfer.bytes }))
    .sort((a, b) => a.start - b.start)
  let busy = 0
  let bytes = 0
  let reach = -Infinity
  for (const span of spans) {
    bytes += span.bytes
    if (span.end <= reach) continue
    busy += span.end - Math.max(span.start, reach)
    reach = span.end
  }
  if (busy < MIN_BUSY_MS) return 0
  return Math.round((bytes * 8) / busy)
}

const transfers: Transfer[] = []
let mediaKbps = 0

export function recordTransfer(start: number, end: number, bytes: number): void {
  if (!(end > start) || !(bytes > 0)) return
  transfers.push({ start, end, bytes })
  const from = end - WINDOW_MS
  while (transfers.length > 0 && transfers[0].end <= from) transfers.shift()
}

export function recordMediaBitrate(bitsPerSecond: number): void {
  if (Number.isFinite(bitsPerSecond) && bitsPerSecond > 0) mediaKbps = Math.round(bitsPerSecond / 1000)
}

export function playbackHealth(now = performance.now()): { bandwidthKbps: number; mediaKbps: number } {
  return { bandwidthKbps: throughputKbps(transfers, now), mediaKbps }
}

/**
 * A touch device keeps far less media in MSE than a desktop; holding what has
 * already played spends that quota on the past and leaves seconds ahead.
 */
export const TOUCH_BACK_BUFFER_SEC = 30

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}
