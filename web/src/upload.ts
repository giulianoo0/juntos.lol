/**
 * Getting a source into a room. There is exactly one way: this browser
 * remuxes the source itself and publishes the segments straight into the
 * bucket (see pipeline/clientMedia). The server creates the room, signs the
 * bucket writes and accepts the playlists; it never sees the video bytes and
 * never runs ffmpeg. A source this browser cannot remux is a room that does
 * not open, and the host is told why.
 */
import { formatSeekTrace, type SeekTrace } from './pipeline/seekTrace'
import { mockCreateRoom, mocksEnabled } from './mocks'
import type { TorrentSession, TorrentStats, TorrentVideoFile } from './torrent'
import type { ClientRemuxHandle } from './pipeline/clientMedia'
// From the leaf module, never from remuxJob: a value import of remuxJob here
// pulls mediabunny and its WASM decoders into the chunk the browser parses
// before the first paint, and defeats the dynamic import further down.
import { jobIsCloneable, sourceSize, type RemuxJob, type RemuxSideFile, type RemuxSource } from './pipeline/remuxTypes'
import { FILE_UNREADABLE, SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, isUnreadableFile, readFailureCode } from './uploadErrors'

export { FILE_UNREADABLE, SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, WORKER_UNREACHABLE, isUnreadableFile } from './uploadErrors'

const REGISTRY_TTL_MS = 30_000

interface CreateRoomResponse {
  id: string
  nickname: string
  ownerToken?: string
}

// The room creator's proof of ownership. A reload joins as a brand new member
// — the server has no other way to tell the host apart from a guest — so this
// is what hands the controls back instead of leaving the host a spectator of
// their own room. localStorage rather than sessionStorage: reopening the link
// in a new tab is half the real cases.
const ownerKey = (roomID: string) => `ss.owner.${roomID}`

export function ownerTokenFor(roomID: string): string {
  try {
    return localStorage.getItem(ownerKey(roomID)) || ''
  } catch {
    return ''
  }
}

function rememberOwnerToken(room: CreateRoomResponse): void {
  if (!room.ownerToken) return
  try { localStorage.setItem(ownerKey(room.id), room.ownerToken) } catch { /* private mode: the host simply cannot resume */ }
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

// The torrent sessions feeding rooms from this tab, so the room's preparing
// screen can show what the swarm is doing — the wait is the swarm's, and only
// this machine can see it.
const torrentSessions = new Map<string, TorrentSession>()

// What this tab's pipeline for each room feeds from, announced to the room so
// everyone can see whose browser the video depends on.
const origins = new Map<string, SourceOrigin>()
export type SourceOrigin = 'file' | 'torrent' | 'url'

/** What this tab's pipeline for the room feeds from, when this tab runs one. */
export function sourceOriginFor(roomID: string): SourceOrigin | null {
  return origins.get(roomID) ?? null
}

/** The swarm behind this room's upload, when this tab is fetching it. */
export function torrentStatsFor(roomID: string): TorrentStats | null {
  return torrentSessions.get(roomID)?.stats() ?? null
}

/** Whether this tab still has a transfer running (or freshly failed) for the room. */
export function uploadActive(roomID: string): boolean {
  const entry = uploads.get(roomID)
  return entry !== undefined && !entry.done
}

// ---- resumable sources ----
//
// The pipeline lives in the host's tab, so a reload kills the room's preparo
// with it. The source is remembered here — the magnet or the URL, never the
// bytes — so re-entering the room can reopen the swarm and pick up where the
// playhead is. A plain file upload has no way back: the File handle dies with
// the page.

export interface ResumableSource {
  kind: 'torrent' | 'url'
  fileName: string
  magnet?: string
  filePath?: string
  url?: string
  size?: number
  savedAt: number
}

// Matches the room's own five-hour life; a stale entry only wastes a swap.
const RESUME_TTL_MS = 5 * 60 * 60 * 1000
const resumeKey = (roomID: string) => `ss.resume.${roomID}`

function saveResumableSource(roomID: string, source: Omit<ResumableSource, 'savedAt'>): void {
  try {
    localStorage.setItem(resumeKey(roomID), JSON.stringify({ ...source, savedAt: Date.now() }))
  } catch { /* private mode: the preparo just will not survive a reload */ }
}

export function resumableSourceFor(roomID: string): ResumableSource | null {
  try {
    const raw = localStorage.getItem(resumeKey(roomID))
    if (!raw) return null
    const source = JSON.parse(raw) as ResumableSource
    if (!source || typeof source.savedAt !== 'number' || Date.now() - source.savedAt > RESUME_TTL_MS) {
      localStorage.removeItem(resumeKey(roomID))
      return null
    }
    return source
  } catch {
    return null
  }
}

export function clearResumableSource(roomID: string): void {
  try { localStorage.removeItem(resumeKey(roomID)) } catch { /* nothing to clear */ }
}

async function createRoom(fileName: string, nickname: string, kind?: string): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, nickname, kind }),
  })
  if (!response.ok) throw new Error('create room failed')
  const created = await response.json() as CreateRoomResponse
  rememberOwnerToken(created)
  return created
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

// A picked File is a snapshot of a path, and browsers invalidate it the moment
// the bytes underneath change. A file that is still downloading changes
// constantly, so every read of it throws and the upload sends nothing at all.
// Reading one byte up front turns that into an answer before a room exists,
// instead of an empty room that never receives anything.
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
  const pct = entry.progress.bytesTotal > 0 ? Math.round((bytesUploaded / entry.progress.bytesTotal) * 100) : 0
  // The remux posts progress many times a second and the readout is rounded:
  // most of those emissions carry the numbers already on screen, and each one
  // re-rendered the whole room. Nothing changed, nothing is announced.
  if (pct === entry.progress.pct && bytesUploaded === entry.progress.bytesUploaded) return
  entry.progress = { ...entry.progress, pct, bytesUploaded }
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
  startRoomUpload(roomID, mediaGeneration, { kind: 'file', file }, [], { onProgress })
}

// The helper keeps downloading for as long as the session lives, so it is
// torn down with the transfer, whichever way that ends.
export function startTorrentUpload(
  roomID: string,
  mediaGeneration: number,
  { file, session }: TorrentUploadSource,
  onProgress?: (progress: UploadProgress) => void,
): void {
  torrentSessions.set(roomID, session)
  if (session.magnet) {
    saveResumableSource(roomID, { kind: 'torrent', fileName: file.name, magnet: session.magnet, filePath: file.path })
  }
  // With a worker grant the job is plain data and runs in the remux worker;
  // a session without one (mocks, tests) pins the job to this thread.
  const source: RemuxSource = file.worker
    ? { kind: 'worker', grant: file.worker }
    : { kind: 'torrentFile', file }
  const sideFiles: RemuxSideFile[] = session.subtitleFiles.map((side) => ({
    name: side.name,
    path: side.path,
    size: side.size,
    ...(file.worker && side.index !== undefined ? { workerIndex: side.index }
      : side.streamUrl ? { url: side.streamUrl }
        : { read: () => side.read() }),
  }))
  startRoomUpload(roomID, mediaGeneration, source, sideFiles, {
    onProgress,
    cleanup: () => {
      // By identity: a source swap registers its own session before this
      // one's transfer notices it lost the room.
      if (torrentSessions.get(roomID) === session) torrentSessions.delete(roomID)
      session.destroy()
    },
  })
}

export function startUrlUpload(
  roomID: string,
  mediaGeneration: number,
  url: string,
  fileName: string,
  size: number,
): void {
  saveResumableSource(roomID, { kind: 'url', fileName, url, size })
  startRoomUpload(roomID, mediaGeneration, { kind: 'url', url, name: fileName, size }, [])
}

interface RoomUploadOptions {
  onProgress?: (progress: UploadProgress) => void
  /** Runs once the transfer ends, however it ends. */
  cleanup?: () => void
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
  source: RemuxSource,
  sideFiles: RemuxSideFile[],
  { onProgress, cleanup = () => {} }: RoomUploadOptions = {},
): void {
  // The progress entry is registered synchronously: Room.tsx subscribes once
  // on mount, and deferring the entry behind the worker spawn would show no
  // progress at all.
  const job: RemuxJob = { roomID, mediaGeneration, source, sideFiles }
  origins.set(roomID, source.kind === 'file' ? 'file' : source.kind === 'url' ? 'url' : 'torrent')
  const size = sourceSize(source)
  const entry = createEntry(size)
  uploads.set(roomID, entry)
  if (onProgress) entry.progressListeners.add((progress) => onProgress({ phase: 'uploading', pct: progress.pct }))
  // Deleting by identity, never by key alone: a source swap starts the next
  // pipeline before this one notices it lost the room, and this one's exit
  // must not take the successor's handle with it.
  let ownHandle: ClientRemuxHandle | null = null
  const dropHandle = () => {
    if (ownHandle && remuxHandles.get(roomID) === ownHandle) remuxHandles.delete(roomID)
  }
  const finish = (error: string | null, detail?: string) => {
    dropHandle()
    // Kept for the report a person can copy off the failure screen: the code
    // is what the screen renders, this is what says why.
    lastFailureDetail = error === null ? null : detail ?? null
    // The source stays either way, for as long as the room can live: a
    // failed run so re-entering the room can try the preparo again, and a
    // finished one so a seek into a stretch the bucket somehow never got —
    // an upload that died on the way, a region that closed short — can
    // still bring the preparo back rather than wait for ever.
    finishEntry(roomID, entry, error, cleanup)
  }
  // The controller swapped the source; another upload owns the room now.
  // Not a failure of this one, so nobody is told of it.
  const movedOn = () => {
    if (uploads.get(roomID) === entry) uploads.delete(roomID)
    dropHandle()
    cleanup()
  }
  const onProgressPct = (pct: number) => updateEntry(entry, Math.round((pct / 100) * size))

  // The remux runs in its own thread whenever the job is plain data: the
  // demux, the mux and every upload otherwise share the main thread with the
  // page drawing the player, and the page visibly stutters for the whole
  // preparo. The page-thread path stays for sources that cannot cross
  // (mocks, tests) and environments without workers.
  if (typeof Worker !== 'undefined' && jobIsCloneable(job)) {
    const worker = new Worker(new URL('./pipeline/remuxWorker.ts', import.meta.url), { type: 'module' })
    ownHandle = { follow: (absoluteMs) => worker.postMessage({ type: 'follow', absoluteMs }) }
    const settle = (fn: () => void) => { fn(); worker.terminate() }
    worker.onmessage = (event: MessageEvent<{ type: string; pct?: number; code?: string; detail?: string; trace?: SeekTrace }>) => {
      const message = event.data
      if (message.type === 'trouble') console.error('[remux-worker]', message.detail)
      // The worker's own console is easy to never look at; the page's is
      // what a person, or a rig, reads.
      else if (message.type === 'trace' && message.trace) console.info(formatSeekTrace('host', message.trace))
      else if (message.type === 'progress') onProgressPct(message.pct ?? 0)
      else if (message.type === 'handle' && ownHandle) remuxHandles.set(roomID, ownHandle)
      else if (message.type === 'done') settle(() => finish(null))
      else if (message.type === 'moved-on') settle(movedOn)
      else if (message.type === 'failed') settle(() => finish(message.code ?? 'upload failed', message.detail))
    }
    worker.onerror = (event) => settle(() => finish(event.message || 'upload failed'))
    worker.postMessage({ type: 'start', job })
    return
  }

  void (async () => {
    // A dynamic import so the remuxer and its WASM audio decoders live in
    // their own chunk, paid for only when an upload actually starts.
    const [{ runRemuxJob, PlanFailedError, UnsupportedMediaError }, pipeline] = await Promise.all([
      import('./pipeline/remuxJob'),
      import('./pipeline/clientMedia'),
    ])
    try {
      await runRemuxJob(job, {
        onProgress: onProgressPct,
        onHandle: (handle) => {
          ownHandle = handle
          remuxHandles.set(roomID, handle)
        },
      })
      finish(null)
    } catch (error) {
      if (error instanceof pipeline.RoomMovedOnError) { movedOn(); return }
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (error instanceof UnsupportedMediaError) { finish(UNSUPPORTED_MEDIA, error.reason ?? detail); return }
      if (error instanceof PlanFailedError) {
        const cause = error.failure
        const why = cause instanceof Error ? `plan failed: ${cause.name}: ${cause.message}` : `plan failed: ${String(cause)}`
        // Planning reads the source, so name a read failure for what it is:
        // a swarm that stopped answering is not a file this browser cannot
        // play, and this path is the one a live torrent session takes.
        finish(readFailureCode(cause, source.kind)
          ?? (source.kind === 'url' ? SOURCE_UNREACHABLE : UNSUPPORTED_MEDIA), why)
        return
      }
      console.error('client media pipeline failed', error)
      finish(readFailureCode(error, source.kind) ?? (error instanceof Error ? error.message : 'upload failed'), detail)
    }
  })()
}

// The last preparo failure's detail, for the report the failure screen can
// copy. One room prepares at a time in a tab, and only the screen that is
// showing the failure ever asks.
let lastFailureDetail: string | null = null

export function lastUploadFailureDetail(): string | null {
  return lastFailureDetail
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
