import Uppy from '@uppy/core'
import Tus from '@uppy/tus'
import { convertMp4ToMkv, isMp4 } from './convert'
import { extractAndUploadSubtitles } from './subtitles'
import type { TorrentSession, TorrentVideoFile } from './torrent'

const TUS_CHUNK_BYTES = 50 * 1024 * 1024
const TORRENT_CHUNK_BYTES = 8 * 1024 * 1024
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

async function createRoom(fileName: string, nickname: string): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, nickname }),
  })
  if (!response.ok) throw new Error('create room failed')
  return await response.json() as CreateRoomResponse
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
  // MP4s with a trailing moov atom cannot be remuxed progressively on the
  // server, so remux to Matroska locally first (codec copy). On failure the
  // original file is uploaded unchanged; a missing video track rejects.
  let uploadFile = file
  if (isMp4(file)) {
    const converted = await convertMp4ToMkv(file, (pct) => onProgress?.({ phase: 'converting', pct }))
    if (converted) uploadFile = converted
  }
  const room = await createRoom(uploadFile.name, nickname)
  const startBytes = streamStartBytes(room)
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
  uppy.on('complete', (result) => finish(result.failed?.length ? 'upload failed' : null))
  uppy.on('error', (error) => finish(error instanceof Error ? error.message : 'upload failed'))
  void uppy.upload().catch((error: unknown) => finish(error instanceof Error ? error.message : 'upload failed'))

  // Fire-and-forget: server-side extraction at completion stays the fallback.
  // For a converted file this runs against the fresh MKV; for an unconverted
  // MP4 it silently no-ops.
  void extractAndUploadSubtitles(uploadFile, room.id)

  return { roomID: room.id, nickname: room.nickname }
}

export async function createRoomAndUploadTorrent(
  source: TorrentUploadSource,
  nickname: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const { file, session } = source
  const room = await createRoom(file.name, nickname)
  const startBytes = streamStartBytes(room)
  const entry = createEntry(file.size, startBytes)
  uploads.set(room.id, entry)
  if (onProgress) entry.progressListeners.add((value) => onProgress({ phase: 'uploading', pct: value.pct }))

  const finish = (error: string | null) => finishEntry(room.id, entry, error, session.destroy)
  void (async () => {
    let uploadURL = ''
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

      let offset = 0
      while (offset < file.size) {
        // The very first request only waits for the server's preview threshold;
        // later requests are larger for better throughput.
        const chunkSize = offset === 0 ? Math.min(startBytes, file.size) : Math.min(TORRENT_CHUNK_BYTES, file.size - offset)
        const body = await file.read(offset, offset + chunkSize - 1)
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
        offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + body.byteLength
        updateEntry(entry, offset)
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

  return { roomID: room.id, nickname: room.nickname }
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
