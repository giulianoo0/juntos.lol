/** Segment names the muxer produces: `cs_{playlist}_{n}.m4s` for region zero,
 * `r{region}_cs_{playlist}_{n}.m4s` for every region after it. Init segments
 * and playlists are named differently and never match. */
const SEGMENT_NAME = /^(?:r(\d+)_)?cs_(\d+)_(\d+)\.m4s$/

interface Region {
  /** Every playlist the muxer has emitted a segment for. A playlist with
   * nothing confirmed yet still counts, as a zero. */
  emitted: Map<number, number>
  confirmed: Map<number, number>
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
  /** Whether every segment this region emitted has reached the bucket. A
   * region that ran to the end of the file may still claim the tail the
   * segment count rounds off, but only once nothing is in flight. */
  settled(region: number): boolean
}

export function createSegmentLedger(): SegmentLedger {
  const regions = new Map<number, Region>()
  // A name the server vouches for more than once — a retried confirm, a
  // batch replayed after a failure — must not lift the count twice.
  const counted = new Set<string>()

  const at = (region: number): Region => {
    let found = regions.get(region)
    if (!found) {
      found = { emitted: new Map(), confirmed: new Map() }
      regions.set(region, found)
    }
    return found
  }

  const bump = (counts: Map<number, number>, playlist: number) => {
    counts.set(playlist, (counts.get(playlist) ?? 0) + 1)
  }

  const parse = (name: string): { region: number; playlist: number } | null => {
    const match = SEGMENT_NAME.exec(name)
    if (!match) return null
    return { region: Number(match[1] ?? 0), playlist: Number(match[2]) }
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
        bump(at(parsed.region).confirmed, parsed.playlist)
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
