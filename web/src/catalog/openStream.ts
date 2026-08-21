import { openTorrent, type TorrentSession, type TorrentVideoFile } from '../torrent'
import { buildMagnet, type CatalogStream } from './streams'

// Opens the addon stream as a torrent session and picks the video file it
// points at, so a catalog pick never goes through the manual file picker.
// The addon's filename hint wins, then its file index (season packs often
// carry only that); last resort is session.files[0], which openTorrent keeps
// sorted largest-first — right for single-video releases.
export async function openCatalogStream(
  stream: CatalogStream,
  onStats?: Parameters<typeof openTorrent>[1],
): Promise<{ file: TorrentVideoFile; session: TorrentSession }> {
  const session = await openTorrent(buildMagnet(stream), onStats)
  const file = (stream.fileName ? session.files.find((candidate) => candidate.name === stream.fileName) : undefined)
    ?? (stream.fileIdx !== null ? session.files.find((candidate) => candidate.index === stream.fileIdx) : undefined)
    ?? session.files[0]
  if (!file) {
    session.destroy()
    throw new Error('stream torrent has no playable video file')
  }
  return { file, session }
}
