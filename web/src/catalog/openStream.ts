import { openTorrent, type TorrentSession, type TorrentVideoFile } from '../torrent'
import { buildMagnet, type CatalogStream, type StreamLocation, type StreamTarget } from './streams'

type TorrentLocation = Extract<StreamLocation, { kind: 'torrent' }>

const basename = (path: string): string => path.split('/').pop() ?? path

/**
 * Matches one episode's file inside a season pack.
 *
 * Release names write the same episode a handful of ways — `S01E02`,
 * `s1.e2`, `1x02` — and the season digits are padded inconsistently, so the
 * pattern is built from the numbers rather than from a fixed shape. The
 * trailing guard is what keeps episode 1 from matching `E11`.
 */
export function episodePattern(season: number, episode: number): RegExp {
  const s = `0*${season}`
  const e = `0*${episode}`
  return new RegExp(`(?:s${s}[\\s._-]*(?:e|ep)${e}|(?<![\\d])${s}x${e})(?![\\d])`, 'i')
}

/**
 * Picks the file a catalog stream actually points at.
 *
 * The addon's filename hint wins: Torrentio carries it on every stream and it
 * names the episode exactly. What it does not carry is a trustworthy index —
 * `fileIdx` is 0 on most season packs, including ones holding five seasons —
 * so when the hint does not match a file in the torrent, the episode is found
 * by reading the names, and only then is the addon's index believed.
 */
export function pickStreamFile(
  files: TorrentVideoFile[],
  location: TorrentLocation,
  target?: StreamTarget,
): TorrentVideoFile | undefined {
  if (files.length <= 1) return files[0]

  if (location.fileName) {
    const wanted = basename(location.fileName).toLowerCase()
    const byName = files.find((file) => basename(file.path).toLowerCase() === wanted)
    if (byName) return byName
  }

  if (target?.season != null && target?.episode != null) {
    const pattern = episodePattern(target.season, target.episode)
    // A pack can hold the episode twice — a sample, an alternate cut — and the
    // real one is the big one.
    const matches = files.filter((file) => pattern.test(file.path))
    if (matches.length) return matches.reduce((best, file) => (file.size > best.size ? file : best))
  }

  if (location.fileIdx !== null) {
    const byIdx = files.find((file) => file.index === location.fileIdx)
    if (byIdx) return byIdx
  }

  // Largest-first, which is right for a single-video release and a guess for
  // anything else.
  return files[0]
}

// Opens the addon stream as a torrent session and points the swarm at the one
// file it means, so a catalog pick never goes through the manual file picker
// and a season pack never downloads whole.
export async function openCatalogStream(
  stream: CatalogStream,
  target?: StreamTarget,
  onStats?: Parameters<typeof openTorrent>[1],
): Promise<{ file: TorrentVideoFile; session: TorrentSession }> {
  const { location } = stream
  // A url stream never reaches here: it has no swarm to open, and the callers
  // branch on the location before choosing this path.
  if (location.kind !== 'torrent') throw new Error('openCatalogStream expects a torrent stream')
  const session = await openTorrent(buildMagnet(location, stream.label), onStats)
  const file = pickStreamFile(session.files, location, target)
  if (!file) {
    session.destroy()
    throw new Error('stream torrent has no playable video file')
  }
  // Focus the swarm on this one file; without it a season pack downloads whole.
  try {
    await session.select(file.path)
  } catch (error) {
    session.destroy()
    throw error
  }
  return { file, session }
}
