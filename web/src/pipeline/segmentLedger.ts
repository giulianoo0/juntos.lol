/** Segment names the muxer produces: `cs_{playlist}_{n}.m4s` for region zero,
 * `r{region}_cs_{playlist}_{n}.m4s` for every region after it. Init segments
 * and playlists are named differently and never match. */
const SEGMENT_NAME = /^(?:r(\d+)_)?cs_(\d+)_(\d+)\.m4s$/

interface Region {
  /** Every playlist the muxer has emitted a segment for. A playlist with
   * nothing confirmed yet still counts, as a zero. */
  emitted: Map<number, number>
  confirmed: Map<number, number>
  /** Which segment numbers landed, per playlist. A count is not a length: a
   * region a seek abandoned drops uploads out of the middle of its queue, so
   * the names that confirm afterwards leave holes. Anything that cuts a
   * playlist has to know where the first hole is, not how many landed. */
  landed: Map<number, Set<number>>
  /** Segment lengths per playlist, in playlist order, from the rendered m3u8. */
  durations: Map<number, number[]>
}

export interface SegmentLedger {
  /** The muxer finished a file. Registers the playlist so a rendition that
   * has not confirmed anything still holds its region's span down. */
  noteEmitted(name: string): void
  /** The server vouched for these names: the bucket holds them and the
   * playlists the viewer fetches can reach them. */
  noteConfirmed(names: Iterable<string>): void
  /** Segments of this region a viewer can actually play. */
  covered(region: number): number
  /** The playlist the muxer rendered for one rendition, in order: each
   * segment's real length. The muxer only closes a segment on a keyframe at
   * or past the target, so a long GOP makes segments far longer than the
   * target — counting them as the target undercounts the region by the same
   * factor, and a seek into its unclaimed tail restarts the whole pipeline
   * for media the bucket already holds. */
  noteDurations(region: number, playlist: number, durationsSec: readonly number[]): void
  /** Milliseconds of this region a viewer can actually play: the shortest
   * rendition's unbroken run from its first segment, summed by real length.
   * A rendition whose playlist has not been seen yet is counted at the
   * fallback length per segment. */
  coveredMs(region: number, fallbackSegmentMs: number): number
  /** Mean and longest segment this region has rendered, for the log. */
  segmentStats(region: number): { count: number; meanSec: number; maxSec: number }
  /** Whether every segment this region emitted has reached the bucket. A
   * region that ran to the end of the file may still claim the tail the
   * segment count rounds off, but only once nothing is in flight. */
  settled(region: number): boolean
  /** How long one rendition's playlist can be: the run of segments from the
   * first, unbroken. The server cuts at its own first unconfirmed name, so
   * anything past a hole is unreachable however much landed after it. */
  contiguousIn(region: number, playlist: number): number
}

export function createSegmentLedger(): SegmentLedger {
  const regions = new Map<number, Region>()
  // A name the server vouches for more than once — a retried confirm, a
  // batch replayed after a failure — must not lift the count twice.
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
    // The muxer numbers a playlist's segments from one.
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
      // The shortest playlist decides: a viewer needs the video segment and
      // its audio rendition both, and the server cuts each playlist at its
      // own first unconfirmed name.
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
