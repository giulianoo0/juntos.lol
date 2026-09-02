/** Segment names the muxer produces: `cs_{playlist}_{n}.m4s` for region zero,
 * `r{region}_cs_{playlist}_{n}.m4s` for every region after it. Init segments
 * and playlists are named differently and never match. */
const SEGMENT_NAME = /^(?:r(\d+)_)?cs_(\d+)_(\d+)\.m4s$/

interface Region {
  emitted: Map<number, number>
  confirmed: Map<number, number>
  landed: Map<number, Set<number>>
  durations: Map<number, number[]>
}

export interface SegmentLedger {
  noteEmitted(name: string): void
  noteConfirmed(names: Iterable<string>): void
  /** Segments of this region a viewer can actually play. */
  covered(region: number): number
  noteDurations(region: number, playlist: number, durationsSec: readonly number[]): void
  /** Milliseconds of this region a viewer can actually play: the shortest
   * rendition's unbroken run from its first segment, by real segment length. */
  coveredMs(region: number, fallbackSegmentMs: number): number
  segmentStats(region: number): { count: number; meanSec: number; maxSec: number }
  /** Whether every segment this region emitted has reached the bucket. */
  settled(region: number): boolean
  /** How long one rendition's playlist can be: the unbroken run of segments
   * from the first, since anything past a hole is unreachable. */
  contiguousIn(region: number, playlist: number): number
}

export function createSegmentLedger(): SegmentLedger {
  const regions = new Map<number, Region>()
  const counted = new Set<string>()

  const at = (region: number): Region => {
    let found = regions.get(region)
    if (!found) {
      found = { emitted: new Map(), confirmed: new Map(), landed: new Map(), durations: new Map() }
      regions.set(region, found)
    }
    return found
  }

  const bump = (counts: Map<number, number>, playlist: number) => {
    counts.set(playlist, (counts.get(playlist) ?? 0) + 1)
  }

  const parse = (name: string): { region: number; playlist: number; n: number } | null => {
    const match = SEGMENT_NAME.exec(name)
    if (!match) return null
    return { region: Number(match[1] ?? 0), playlist: Number(match[2]), n: Number(match[3]) }
  }

  const contiguous = (region: number, playlist: number): number => {
    const landed = regions.get(region)?.landed.get(playlist)
    if (!landed) return 0
    let run = 0
    while (landed.has(run + 1)) run += 1
    return run
  }

  return {
    noteEmitted(name) {
      const parsed = parse(name)
      if (!parsed) return
      bump(at(parsed.region).emitted, parsed.playlist)
    },
    noteConfirmed(names) {
      for (const name of names) {
        if (counted.has(name)) continue
        const parsed = parse(name)
        if (!parsed) continue
        counted.add(name)
        const region = at(parsed.region)
        bump(region.confirmed, parsed.playlist)
        let landed = region.landed.get(parsed.playlist)
        if (!landed) {
          landed = new Set()
          region.landed.set(parsed.playlist, landed)
        }
        landed.add(parsed.n)
      }
    },
    covered(region) {
      const found = regions.get(region)
      if (!found || found.emitted.size === 0) return 0
      let shortest = Infinity
      for (const playlist of found.emitted.keys()) {
        shortest = Math.min(shortest, found.confirmed.get(playlist) ?? 0)
      }
      return shortest === Infinity ? 0 : shortest
    },
    contiguousIn(region, playlist) {
      return contiguous(region, playlist)
    },
    noteDurations(region, playlist, durationsSec) {
      at(region).durations.set(playlist, [...durationsSec])
    },
    coveredMs(region, fallbackSegmentMs) {
      const found = regions.get(region)
      if (!found || found.emitted.size === 0) return 0
      let shortest = Infinity
      for (const playlist of found.emitted.keys()) {
        const run = contiguous(region, playlist)
        const known = found.durations.get(playlist) ?? []
        let ms = 0
        for (let i = 0; i < run; i += 1) {
          ms += i < known.length ? Math.round(known[i] * 1000) : fallbackSegmentMs
        }
        shortest = Math.min(shortest, ms)
      }
      return shortest === Infinity ? 0 : shortest
    },
    segmentStats(region) {
      const all = [...(regions.get(region)?.durations.values() ?? [])].flat()
      if (all.length === 0) return { count: 0, meanSec: 0, maxSec: 0 }
      const sum = all.reduce((a, b) => a + b, 0)
      return { count: all.length, meanSec: sum / all.length, maxSec: Math.max(...all) }
    },
    settled(region) {
      const found = regions.get(region)
      if (!found || found.emitted.size === 0) return false
      for (const [playlist, count] of found.emitted) {
        if ((found.confirmed.get(playlist) ?? 0) < count) return false
      }
      return true
    },
  }
}
