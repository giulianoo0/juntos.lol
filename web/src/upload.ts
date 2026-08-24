/**
 * Getting a source into a room. There is exactly one way: this browser
 * remuxes the source itself and publishes the segments straight into the
 * bucket (see pipeline/clientMedia). The server creates the room, signs the
 * bucket writes and accepts the playlists; it never sees the video bytes and
 * never runs ffmpeg. A source this browser cannot remux is a room that does
 * not open, and the host is told why.
 */
import {
  createMatroskaSubtitleStream,
  createSubtitleCollector,
  isMatroska,
  type SubtitleCollector,
} from './subtitles'
import { convertSubtitleFile, type VttTrack } from './subtitleFormats'
import { mockCreateRoom, mocksEnabled } from './mocks'
import type { TorrentSession, TorrentSideFile, TorrentVideoFile } from './torrent'
import { fileInput, torrentInput, urlInput, type MediaInput } from './pipeline/mediaInput'
import type { ClientRemuxHandle } from './pipeline/clientMedia'

// Headroom under the server's per-room track cap for the tracks muxed into
// the video itself.
const MAX_EXTERNAL_SUBTITLES = 16
// How often the cues seen so far are republished while bytes keep arriving.
const SUBTITLE_SNAPSHOT_MS = 8_000
// The slice a subtitle pass reads at a time. Big enough that a torrent read
// is worth the round trip, small enough to keep memory flat on a 50 GB file.
const SUBTITLE_SLICE_BYTES = 8 * 1024 * 1024
const REGISTRY_TTL_MS = 30_000

interface CreateRoomResponse {
  id: string
  nickname: string
}

export interface UploadResult {
  roomID: string
  nickname: string
}

export interface UploadProgress {
  phase: 'converting' | 'uploading'
  pct: number
}

export interface RoomUploadProgress {
  pct: number
  bytesUploaded: number
  bytesTotal: number
}

interface UploadEntry {
  progress: RoomUploadProgress
  done: boolean
  error: string | null
  progressListeners: Set<(progress: RoomUploadProgress) => void>
  doneListeners: Set<(err: string | null) => void>
}

interface TorrentUploadSource {
  file: TorrentVideoFile
  session: TorrentSession
}

// Uploads outlive the Home component, so keep the state module-level and let
// the room page subscribe after navigation.
const uploads = new Map<string, UploadEntry>()

// The live remux pipelines by room, so the room page can feed the shared
// playhead to the one producing its media. Only the host ever has an entry.
const remuxHandles = new Map<string, ClientRemuxHandle>()

/** The running remux pipeline for this room, when this tab is its host. */
export function remuxHandleFor(roomID: string): ClientRemuxHandle | undefined {
  return remuxHandles.get(roomID)
}

async function createRoom(fileName: string, nickname: string, kind?: string): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, nickname, kind }),
  })
  if (!response.ok) throw new Error('create room failed')
  return await response.json() as CreateRoomResponse
}

// A shared screen has no file and no pipeline: the room opens ready and the
// picture arrives over WebRTC.
export async function createScreenRoom(nickname: string): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const room = await createRoom('', nickname, 'screen')
  return { roomID: room.id, nickname: room.nickname }
}

// What the room plays after the controller swaps its source.
export interface RoomSource {
  status: string
  sourceKind: 'upload' | 'screen'
  fileName: string
  mediaGeneration: number
}

// Repoints an existing room at a new source. Only the controller is allowed
// to, and everyone stays where they are: nobody moves to another room.
export async function changeRoomSource(
  roomID: string,
  memberId: string,
  capability: string,
  kind: 'upload' | 'screen',
  fileName?: string,
): Promise<RoomSource> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, kind, fileName }),
  })
  if (!response.ok) throw new Error(`change source failed (${response.status})`)
  return await response.json() as RoomSource
}

// The errors a transfer reports by name, because each has its own remedy and
// the room page says a different thing for each.
//
// A file that changed on disk: wait for the download to finish, pick again.
export const FILE_UNREADABLE = 'file-unreadable'
// This browser cannot remux this source — a codec it cannot decode, a
// container it cannot read. Another browser, or another release.
export const UNSUPPORTED_MEDIA = 'unsupported-media'
// A url source that refused the browser (no CORS, no Range). Nothing here can
// fix that; a different stream can.
export const SOURCE_UNREACHABLE = 'source-unreachable'

// A picked File is a snapshot of a path, and browsers invalidate it the moment
// the bytes underneath change. A file that is still downloading changes
// constantly, so every read of it throws and the upload sends nothing at all.
// Reading one byte up front turns that into an answer before a room exists,
// instead of an empty room that never receives anything.
export function isUnreadableFile(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'NotReadableError' || error.name === 'NotFoundError'
  return error instanceof Error && error.message === FILE_UNREADABLE
}

export async function assertReadable(file: File): Promise<void> {
  // The tail is what moves while a file is being written, so it is the most
  // telling byte to ask for.
  const probe = file.size > 0 ? file.slice(file.size - 1, file.size) : file.slice(0, 1)
  try {
    await probe.arrayBuffer()
  } catch (error) {
    if (isUnreadableFile(error)) throw new Error(FILE_UNREADABLE)
    throw error
  }
}

function createEntry(bytesTotal: number): UploadEntry {
  return {
    progress: { pct: 0, bytesUploaded: 0, bytesTotal },
    done: false,
    error: null,
    progressListeners: new Set(),
    doneListeners: new Set(),
  }
}

function updateEntry(entry: UploadEntry, bytesUploaded: number) {
  entry.progress = {
    ...entry.progress,
    pct: entry.progress.bytesTotal > 0 ? Math.round((bytesUploaded / entry.progress.bytesTotal) * 100) : 0,
    bytesUploaded,
  }
  for (const listener of entry.progressListeners) listener(entry.progress)
}

function finishEntry(roomID: string, entry: UploadEntry, error: string | null, cleanup: () => void) {
  if (entry.done) return
  entry.done = true
  entry.error = error
  for (const listener of entry.doneListeners) listener(error)
  cleanup()
  setTimeout(() => {
    if (uploads.get(roomID) === entry) uploads.delete(roomID)
  }, REGISTRY_TTL_MS)
}

export async function createRoomAndUpload(
  file: File,
  nickname: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  // A file still being written fails here, before a room exists, not as a
  // room behind that will sit at zero per cent for ever.
  await assertReadable(file)
  const room = await createRoom(file.name, nickname)
  startFileUpload(room.id, 0, file, onProgress)
  return { roomID: room.id, nickname: room.nickname }
}

export async function createRoomAndUploadTorrent(
  source: TorrentUploadSource,
  nickname: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const created = await createRoom(source.file.name, nickname)
  startTorrentUpload(created.id, 0, source, onProgress)
  return { roomID: created.id, nickname: created.nickname }
}

export async function createRoomAndUploadUrl(
  url: string,
  fileName: string,
  size: number,
  nickname: string,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const created = await createRoom(fileName, nickname)
  startUrlUpload(created.id, 0, url, fileName, size)
  return { roomID: created.id, nickname: created.nickname }
}

export function startFileUpload(
  roomID: string,
  mediaGeneration: number,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): void {
  startRoomUpload(roomID, mediaGeneration, fileInput(file), { onProgress })
}

// The helper keeps downloading for as long as the session lives, so it is
// torn down with the transfer, whichever way that ends.
export function startTorrentUpload(
  roomID: string,
  mediaGeneration: number,
  { file, session }: TorrentUploadSource,
  onProgress?: (progress: UploadProgress) => void,
): void {
  startRoomUpload(roomID, mediaGeneration, torrentInput(file), {
    onProgress,
    sideFiles: session.subtitleFiles,
    cleanup: () => session.destroy(),
  })
}

export function startUrlUpload(
  roomID: string,
  mediaGeneration: number,
  url: string,
  fileName: string,
  size: number,
): void {
  startRoomUpload(roomID, mediaGeneration, urlInput(url, fileName, size), { unreachable: SOURCE_UNREACHABLE })
}

interface RoomUploadOptions {
  onProgress?: (progress: UploadProgress) => void
  /** Subtitle files that shipped next to the video, read and published alongside. */
  sideFiles?: TorrentSideFile[]
  /** Runs once the transfer ends, however it ends. */
  cleanup?: () => void
  /** What to report when the source cannot even be read — a url that refused the browser. */
  unreachable?: string
}

/**
 * Remuxes the source here and publishes it into the bucket.
 *
 * The decision is asynchronous but the call is not: the room exists and the
 * caller has already navigated into it either way. Whatever goes wrong is
 * reported through the registry, by name, for the room page to explain.
 */
export function startRoomUpload(
  roomID: string,
  mediaGeneration: number,
  input: MediaInput,
  { onProgress, sideFiles = [], cleanup = () => {}, unreachable = UNSUPPORTED_MEDIA }: RoomUploadOptions = {},
): void {
  // The progress entry is registered synchronously: Room.tsx subscribes once
  // on mount, and deferring the entry behind the dynamic import would show no
  // progress at all.
  const entry = createEntry(input.size)
  uploads.set(roomID, entry)
  if (onProgress) entry.progressListeners.add((progress) => onProgress({ phase: 'uploading', pct: progress.pct }))
  // Deleting by identity, never by key alone: a source swap starts the next
  // pipeline before this one notices it lost the room, and this one's exit
  // must not take the successor's handle with it.
  let ownHandle: ClientRemuxHandle | null = null
  const dropHandle = () => {
    if (ownHandle && remuxHandles.get(roomID) === ownHandle) remuxHandles.delete(roomID)
  }
  const finish = (error: string | null) => {
    dropHandle()
    finishEntry(roomID, entry, error, cleanup)
  }

  void (async () => {
    // A dynamic import so the remuxer and its WASM audio decoders live in
    // their own chunk, paid for only when an upload actually starts.
    const pipeline = await import('./pipeline/clientMedia')
    let plan: Awaited<ReturnType<typeof pipeline.planClientRemux>> = null
    try {
      plan = await pipeline.planClientRemux(input)
    } catch (error) {
      if (isUnreadableFile(error)) { finish(FILE_UNREADABLE); return }
      finish(unreachable)
      return
    }
    if (!plan) { finish(UNSUPPORTED_MEDIA); return }

    // Subtitles run beside the remux, off the same bytes, and publish as they
    // go; the room has them before the video finishes.
    void publishSubtitles(input, sideFiles, roomID, mediaGeneration)
    try {
      await pipeline.runClientRemux({
        roomID,
        mediaGeneration,
        file: input,
        plan,
        onProgress: (pct) => updateEntry(entry, Math.round((pct / 100) * input.size)),
        onHandle: (handle) => {
          ownHandle = handle
          remuxHandles.set(roomID, handle)
        },
      })
      finish(null)
    } catch (error) {
      if (error instanceof pipeline.RoomMovedOnError) {
        // The controller swapped the source; another upload owns the room
        // now. Not a failure of this one, so nobody is told of it.
        if (uploads.get(roomID) === entry) uploads.delete(roomID)
        dropHandle()
        cleanup()
        return
      }
      console.error('client media pipeline failed', error)
      finish(isUnreadableFile(error) ? FILE_UNREADABLE : error instanceof Error ? error.message : 'upload failed')
    }
  })()
}

export function subscribeUploadProgress(roomID: string, callback: (progress: RoomUploadProgress) => void): () => void {
  const entry = uploads.get(roomID)
  if (!entry) return () => undefined
  entry.progressListeners.add(callback)
  callback(entry.progress)
  return () => { entry.progressListeners.delete(callback) }
}

export function subscribeUploadDone(roomID: string, callback: (err: string | null) => void): () => void {
  const entry = uploads.get(roomID)
  if (!entry) return () => undefined
  if (entry.done) {
    callback(entry.error)
    return () => undefined
  }
  entry.doneListeners.add(callback)
  return () => { entry.doneListeners.delete(callback) }
}

// Best effort, never rejects: the tracks muxed into a Matroska source are
// parsed out of a sequential pass over it, and the sibling subtitle files are
// read whole. Both publish as they arrive, and the collector holds the final
// "complete" until every registered source has delivered.
async function publishSubtitles(
  input: MediaInput,
  sideFiles: TorrentSideFile[],
  roomID: string,
  mediaGeneration: number,
): Promise<void> {
  const collector = createSubtitleCollector(roomID, mediaGeneration)
  const external = sideFiles.slice(0, MAX_EXTERNAL_SUBTITLES)
  const embedded = isMatroska(input)
  if (external.length > 0) collector.register('external')
  if (embedded) collector.register('embedded')
  if (external.length === 0 && !embedded) return
  await Promise.all([
    external.length > 0 ? loadExternalSubtitles(external, collector) : Promise.resolve(),
    embedded ? extractEmbeddedSubtitles(input, collector) : Promise.resolve(),
  ])
}

async function extractEmbeddedSubtitles(input: MediaInput, collector: SubtitleCollector): Promise<void> {
  try {
    const stream = await createMatroskaSubtitleStream()
    let lastSnapshotAt = Date.now()
    for (let offset = 0; offset < input.size; offset += SUBTITLE_SLICE_BYTES) {
      stream.write(await input.read(offset, Math.min(offset + SUBTITLE_SLICE_BYTES, input.size)))
      if (Date.now() - lastSnapshotAt >= SUBTITLE_SNAPSHOT_MS) {
        lastSnapshotAt = Date.now()
        collector.publish('embedded', stream.snapshot(), false)
      }
    }
    collector.publish('embedded', await stream.finish(), true)
  } catch (error) {
    console.error('subtitle extraction failed', error)
    collector.publish('embedded', [], true)
  }
  await collector.flush()
}

async function loadExternalSubtitles(files: TorrentSideFile[], collector: SubtitleCollector): Promise<void> {
  const tracks: VttTrack[] = []
  for (const file of files) {
    try {
      const track = convertSubtitleFile(file.path, await file.read())
      if (!track) continue
      tracks.push(track)
      collector.publish('external', [...tracks], false)
    } catch (error) {
      console.warn('external subtitle unavailable', file.path, error)
    }
  }
  collector.publish('external', tracks, true)
  await collector.flush()
}
