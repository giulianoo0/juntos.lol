import Uppy from '@uppy/core'
import Tus from '@uppy/tus'
import { convertMp4ToMkv, isMp4 } from './convert'
import {
  createMatroskaSubtitleStream,
  createSubtitleCollector,
  extractAndUploadSubtitles,
  isMatroska,
  type MatroskaSubtitleStream,
  type SubtitleCollector,
} from './subtitles'
import { convertSubtitleFile, type VttTrack } from './subtitleFormats'
import { mockCreateRoom, mocksEnabled } from './mocks'
import type { TorrentSession, TorrentSideFile, TorrentVideoFile } from './torrent'

const TUS_CHUNK_BYTES = 50 * 1024 * 1024
const TORRENT_CHUNK_BYTES = 8 * 1024 * 1024
// The server accepts 32 subtitle tracks per room; leave headroom for the
// tracks muxed into the video itself.
const MAX_EXTERNAL_SUBTITLES = 16
// How often the cues seen so far are republished while bytes keep arriving.
const SUBTITLE_SNAPSHOT_MS = 8_000
// Subtitle extraction must never hold up the upload. The parser bundle is a
// same-origin asset, so anything slower than this is a failure to move on from.
const SUBTITLE_PARSER_TIMEOUT_MS = 10_000
const REGISTRY_TTL_MS = 30_000
const DEFAULT_STREAM_START_BYTES = 1024 * 1024

interface CreateRoomResponse {
  id: string
  nickname: string
  uploadEndpoint: string
  streamStartBytes?: number
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
  streamStartBytes: number
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
  uploadEndpoint: string
  streamStartBytes: number
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

// The error a file that changed on disk produces, reported separately because
// the remedy is entirely different from a failed transfer: wait, then pick it
// again.
export const FILE_UNREADABLE = 'file-unreadable'

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

// MP4s with a trailing moov atom cannot be remuxed progressively on the
// server, so remux to Matroska locally first (codec copy). On failure the
// original file is used unchanged; a missing video track rejects.
export async function prepareLocalFile(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<File> {
  if (!isMp4(file)) return file
  const converted = await convertMp4ToMkv(file, (pct) => onProgress?.({ phase: 'converting', pct }))
  return converted ?? file
}

function streamStartBytes(room: CreateRoomResponse): number {
  return room.streamStartBytes && room.streamStartBytes > 0
    ? room.streamStartBytes
    : DEFAULT_STREAM_START_BYTES
}

function createEntry(bytesTotal: number, startBytes: number): UploadEntry {
  return {
    progress: { pct: 0, bytesUploaded: 0, bytesTotal, streamStartBytes: startBytes },
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

function encodeMetadata(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function createRoomAndUpload(
  file: File,
  nickname: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  // Before anything is created, so a file that cannot be read never leaves a
  // room behind that will sit at zero per cent for ever.
  await assertReadable(file)
  const uploadFile = await prepareLocalFile(file, onProgress)
  const room = await createRoom(uploadFile.name, nickname)
  uploadFileToRoom(room.id, room.uploadEndpoint, streamStartBytes(room), 0, uploadFile, onProgress)
  return { roomID: room.id, nickname: room.nickname }
}

// Streams a prepared file into a room that already exists, which is what a
// source swap needs: the room, its members and its chat are all already there.
export function uploadFileToRoom(
  roomID: string,
  uploadEndpoint: string,
  startBytes: number,
  mediaGeneration: number,
  uploadFile: File,
  onProgress?: (progress: UploadProgress) => void,
): void {
  const room = { id: roomID, uploadEndpoint }
  const uppy = new Uppy({ autoProceed: false })
  // Keep each PATCH below the common reverse-proxy upload cap while still
  // allowing the server's 10 GB room limit to be reached resumably.
  uppy.use(Tus, { endpoint: room.uploadEndpoint, chunkSize: TUS_CHUNK_BYTES })
  uppy.setMeta({ roomID: room.id })
  uppy.addFile({ name: uploadFile.name, type: uploadFile.type, data: uploadFile })

  const entry = createEntry(uploadFile.size, startBytes)
  uploads.set(room.id, entry)
  if (onProgress) entry.progressListeners.add((progress) => onProgress({ phase: 'uploading', pct: progress.pct }))

  const finish = (error: string | null) => {
    finishEntry(room.id, entry, error, () => uppy.destroy())
  }

  uppy.on('upload-progress', (_file, progress) => {
    const total = progress.bytesTotal ?? uploadFile.size
    const uploaded = progress.bytesUploaded ?? 0
    entry.progress.bytesTotal = total
    updateEntry(entry, uploaded)
  })
  const describe = (error: unknown) => {
    if (isUnreadableFile(error)) return FILE_UNREADABLE
    return error instanceof Error ? error.message : 'upload failed'
  }
  uppy.on('complete', (result) => finish(result.failed?.length ? describe(result.failed[0]?.error) : null))
  uppy.on('error', (error) => finish(describe(error)))
  void uppy.upload().catch((error: unknown) => finish(describe(error)))

  // Fire-and-forget: server-side extraction at completion stays the fallback.
  // For a converted file this runs against the fresh MKV; for an unconverted
  // MP4 it silently no-ops.
  void extractAndUploadSubtitles(uploadFile, room.id, mediaGeneration)
}

/**
 * Points a room at a url and lets the server fetch it. The bytes never touch
 * this browser — the same trade the torrent hand-off makes, for the same
 * reason, and it means the transfer survives the tab closing.
 */
export async function startUrlTransfer(roomID: string, url: string, fileName: string, size: number): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fileName, size }),
  })
  if (response.ok) return
  // The server names which rule barred the address. Dropping that and
  // reporting a bare status would leave the host with nothing to act on:
  // "not https" and "points at your own network" have different fixes.
  let reason = ''
  try {
    const body = await response.json() as { reason?: unknown }
    if (typeof body.reason === 'string') reason = body.reason
  } catch { /* not JSON, which is not itself worth reporting */ }
  throw new Error(reason
    ? `url source refused (${response.status}): ${reason}`
    : `url source refused (${response.status})`)
}

export async function createRoomAndIngestUrl(
  url: string,
  fileName: string,
  size: number,
  nickname: string,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const created = await createRoom(fileName, nickname)
  await startUrlTransfer(created.id, url, fileName, size)
  return { roomID: created.id, nickname: created.nickname }
}

export async function createRoomAndUploadTorrent(
  source: TorrentUploadSource,
  nickname: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const created = await createRoom(source.file.name, nickname)
  await startTorrentTransfer(created.id, created.uploadEndpoint, streamStartBytes(created), 0, source, onProgress)
  return { roomID: created.id, nickname: created.nickname }
}

// Hands the chosen file to the server, which then pulls it from the bridge
// itself. Returns false when there is no bridge session to hand over — the
// in-browser WebTorrent fallback — and the browser has to do the transfer.
async function handOverToServer(roomID: string, source: TorrentUploadSource): Promise<boolean> {
  const sessionID = source.session.bridgeSessionID
  if (!sessionID) return false
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/torrent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionID,
      path: source.file.path,
      fileName: source.file.name,
      size: source.file.size,
    }),
  })
  // A server without the ingest wired up answers 404 for the route itself,
  // which is the one failure that should fall back rather than surface.
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`torrent handover failed (${response.status})`)
  // The session belongs to the server now: tearing it down here would destroy
  // the torrent underneath the download that just started.
  source.session.destroy(true)
  return true
}

// Starts a torrent transfer the best way available: server-side when a bridge
// session can be handed over, and through this browser otherwise.
export async function startTorrentTransfer(
  roomID: string,
  uploadEndpoint: string,
  startBytes: number,
  mediaGeneration: number,
  source: TorrentUploadSource,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  if (await handOverToServer(roomID, source)) return
  uploadTorrentToRoom(roomID, uploadEndpoint, startBytes, mediaGeneration, source, onProgress)
}

// Pulls a torrent into a room that already exists. Same swarm bookkeeping and
// same progressive subtitle extraction as a fresh room, minus the room.
export function uploadTorrentToRoom(
  roomID: string,
  uploadEndpoint: string,
  startBytes: number,
  mediaGeneration: number,
  source: TorrentUploadSource,
  onProgress?: (progress: UploadProgress) => void,
): void {
  const { file, session } = source
  const room = { id: roomID, uploadEndpoint }
  const entry = createEntry(file.size, startBytes)
  uploads.set(room.id, entry)
  if (onProgress) entry.progressListeners.add((value) => onProgress({ phase: 'uploading', pct: value.pct }))

  const finish = (error: string | null) => finishEntry(room.id, entry, error, session.destroy)

  // Subtitles do not need a second pass over the swarm. Sibling subtitle
  // files are fetched directly, and the tracks muxed into the video are
  // parsed from the very bytes that are already being uploaded.
  const collector = createSubtitleCollector(room.id, mediaGeneration)
  const externalSubtitles = session.subtitleFiles.slice(0, MAX_EXTERNAL_SUBTITLES)
  if (externalSubtitles.length > 0) {
    collector.register('external')
    void loadExternalSubtitles(externalSubtitles, collector)
  }

  // Started before the upload handshake so the bundle loads while the tus
  // session is being created.
  let parserPromise: Promise<MatroskaSubtitleStream | null> | null = null
  if (isMatroska(file)) {
    collector.register('embedded')
    parserPromise = createMatroskaSubtitleStream().catch((error: unknown) => {
      console.error('subtitle parser unavailable', error)
      return null
    })
  }

  void (async () => {
    let uploadURL = ''
    let subtitles: MatroskaSubtitleStream | null = null
    try {
      const createResponse = await fetch(room.uploadEndpoint, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(file.size),
          'Upload-Metadata': `roomID ${encodeMetadata(room.id)},filename ${encodeMetadata(file.name)}`,
        },
      })
      if (!createResponse.ok) throw new Error(`torrent upload creation failed (${createResponse.status})`)
      const location = createResponse.headers.get('Location')
      if (!location) throw new Error('torrent upload location missing')
      uploadURL = new URL(location, window.location.href).toString()

      if (parserPromise) {
        subtitles = await withTimeout(parserPromise, SUBTITLE_PARSER_TIMEOUT_MS)
        // A source that never produced a parser stays incomplete, which keeps
        // the authoritative server-side extraction scheduled.
        if (!subtitles) collector.publish('embedded', [], false)
      }

      const readChunk = (at: number) => {
        // The very first request only waits for the server's preview threshold;
        // later requests are larger for better throughput.
        const chunkSize = at === 0 ? Math.min(startBytes, file.size) : Math.min(TORRENT_CHUNK_BYTES, file.size - at)
        return file.read(at, at + chunkSize - 1)
      }

      let offset = 0
      let lastSnapshotAt = Date.now()
      // Swarm reads and PATCHes are both network bound, so the next chunk is
      // pulled from the swarm while the current PATCH is in flight. A single
      // slot of lookahead keeps memory bounded; PATCHes stay strictly
      // sequential, only the reads overlap.
      let prefetch: { offset: number; body: Promise<ArrayBuffer> } | null = null
      while (offset < file.size) {
        const body: ArrayBuffer = prefetch && prefetch.offset === offset ? await prefetch.body : await readChunk(offset)
        prefetch = null
        const expectedNext = offset + body.byteLength
        if (expectedNext < file.size) {
          const next = readChunk(expectedNext)
          // A short write leaves this prefetch unawaited; swallow its
          // rejection there so only the chunk actually used can throw.
          void next.catch(() => undefined)
          prefetch = { offset: expectedNext, body: next }
        }
        const patchResponse = await fetch(uploadURL, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
          },
          body,
        })
        if (!patchResponse.ok) throw new Error(`torrent upload failed (${patchResponse.status})`)
        const nextOffset = Number(patchResponse.headers.get('Upload-Offset'))
        const previousOffset = offset
        offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + body.byteLength
        updateEntry(entry, offset)

        // Feed the parser only the bytes the server actually accepted: a short
        // write is re-read from the new offset, and anything else would splice
        // the container stream and desync the parser for good.
        if (subtitles) {
          const accepted = offset - previousOffset
          if (accepted === body.byteLength) subtitles.write(new Uint8Array(body))
          else if (accepted > 0 && accepted < body.byteLength) subtitles.write(new Uint8Array(body, 0, accepted))
          else subtitles = null
        }
        if (subtitles && Date.now() - lastSnapshotAt >= SUBTITLE_SNAPSHOT_MS) {
          lastSnapshotAt = Date.now()
          collector.publish('embedded', subtitles.snapshot(), false)
        }
      }
      if (subtitles) {
        try {
          collector.publish('embedded', await subtitles.finish(), true)
        } catch (error) {
          console.error('subtitle extraction failed', error)
          // Leave the source incomplete so the server still extracts the
          // authoritative tracks once the upload lands.
          collector.publish('embedded', subtitles.snapshot(), false)
        }
        void collector.flush()
      }
      finish(null)
    } catch (error) {
      if (uploadURL) {
        void fetch(uploadURL, {
          method: 'DELETE',
          headers: { 'Tus-Resumable': '1.0.0' },
        }).catch(() => undefined)
      }
      finish(error instanceof Error ? error.message : 'torrent upload failed')
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

// Reads the subtitle files shipped alongside the video and publishes them as
// they land. Each file is complete on its own, so they are usable long before
// the video finishes downloading.
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    void promise.then((value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) })
  })
}
