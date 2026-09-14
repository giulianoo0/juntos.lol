import { convertSubtitleFile, isSubtitleFileName, type VttTrack } from '../subtitleFormats'
import type { TrackInfo } from '../types'

/** The text formats the converter knows; bitmap subtitles never apply. */
export const SUBTITLE_FILE_ACCEPT = '.srt,.ass,.ssa,.vtt,.sub'
const MAX_TITLE = 120

/** Converts a picked file into a track named after it. Throws 'unsupported'
 * when the file is not a text subtitle or holds no cue. */
export async function readSubtitleFile(file: File): Promise<VttTrack> {
  if (!isSubtitleFileName(file.name)) throw new Error('unsupported')
  const track = convertSubtitleFile(file.name, await file.arrayBuffer())
  if (!track) throw new Error('unsupported')
  return { ...track, title: file.name.slice(0, MAX_TITLE) }
}

/** Posts a host's import so the whole room gets it; resolves with the track
 * as the server indexed it. Throws the server's error code on refusal. */
export async function publishImportedSubtitle(roomId: string, memberId: string, mediaGeneration: number, track: VttTrack): Promise<TrackInfo> {
  const body: Record<string, unknown> = {
    memberId, mediaGeneration, language: track.language, title: track.title, vtt: track.vtt,
  }
  if (track.ass !== undefined) body.ass = track.ass
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/subtitles/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error ?? `import failed (${response.status})`)
  }
  const { subtitleTracks } = await response.json() as { subtitleTracks: TrackInfo[] }
  return subtitleTracks[subtitleTracks.length - 1]
}
