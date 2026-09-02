/**
 * Getting a source into a room. A picked file or a url this browser remuxes
 * itself and publishes straight into the bucket (see pipeline/clientMedia);
 * the server signs the writes and never sees a video byte. A torrent goes
 * the other way: the fleet's worker remuxes it, and this browser only walks
 * the file for subtitles. A source neither can take is a room that does not
 * open, and the host is told why.
 */
import { formatSeekTrace, type SeekTrace } from './pipeline/seekTrace'
import { mockCreateRoom, mocksEnabled } from './mocks'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile, type WorkerGrant } from './torrent'
import type { SubtitleScanJob } from './pipeline/subtitleScan'
import type { ClientRemuxHandle } from './pipeline/clientMedia'
// From the leaf module, never from remuxJob: a value import of remuxJob here
// pulls mediabunny into the first-paint chunk and defeats the dynamic import.
import { jobIsCloneable, sourceSize, type RemuxJob, type RemuxSideFile, type RemuxSource } from './pipeline/remuxTypes'
import { FILE_UNREADABLE, REMUX_UNAVAILABLE, SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, isUnreadableFile, readFailureCode } from './uploadErrors'

export { FILE_UNREADABLE, REMUX_UNAVAILABLE, SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, WORKER_UNREACHABLE, isUnreadableFile } from './uploadErrors'

const REGISTRY_TTL_MS = 30_000

interface CreateRoomResponse {
  id: string
  nickname: string
  ownerToken?: string
}

// The room creator's proof of ownership: a reload joins as a brand new member,
// and this is what hands the controls back. localStorage, not sessionStorage,
// because reopening the link in a new tab is half the real cases.
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
  try { localStorage.setItem(ownerKey(room.id), room.ownerToken) } catch {}
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

const uploads = new Map<string, UploadEntry>()

const remuxHandles = new Map<string, ClientRemuxHandle>()

/** The running remux pipeline for this room, when this tab is its host. */
export function remuxHandleFor(roomID: string): ClientRemuxHandle | undefined {
  return remuxHandles.get(roomID)
}

const torrentSessions = new Map<string, TorrentSession>()

const origins = new Map<string, SourceOrigin>()

// Only the host learns this: the 202 accepting the handoff is theirs.
const remoteProductions = new Set<string>()

/** Whether this room's preparo was handed to the fleet ("R" in the chip). */
export function isRemoteProduction(roomID: string): boolean {
  return remoteProductions.has(roomID)
}
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

// The pipeline lives in the host's tab, so a reload kills the room's preparo.
// The magnet or the URL is remembered — never the bytes — so re-entering the
// room can pick the preparo back up. A picked File has no way back.

export interface ResumableSource {
  kind: 'torrent' | 'url'
  fileName: string
  magnet?: string
  filePath?: string
  url?: string
  size?: number
  savedAt: number
}

const RESUME_TTL_MS = 5 * 60 * 60 * 1000
const resumeKey = (roomID: string) => `ss.resume.${roomID}`

function saveResumableSource(roomID: string, source: Omit<ResumableSource, 'savedAt'>): void {
  try {
    localStorage.setItem(resumeKey(roomID), JSON.stringify({ ...source, savedAt: Date.now() }))
  } catch {}
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
  try { localStorage.removeItem(resumeKey(roomID)) } catch {}
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

export async function createScreenRoom(nickname: string): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const room = await createRoom('', nickname, 'screen')
  return { roomID: room.id, nickname: room.nickname }
}

export interface RoomSource {
  status: string
  sourceKind: 'upload' | 'screen'
  fileName: string
  mediaGeneration: number
}

// Repoints an existing room at a new source; everyone stays where they are.
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

// A File is a snapshot of a path, invalidated the moment the bytes underneath
// change. Reading one byte up front answers that before a room exists.
export async function assertReadable(file: File): Promise<void> {
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

export interface TorrentAuth {
  memberId: string
  capability: string
}

/**
 * Hands the torrent to the fleet. The worker produces the video or nobody
 * does: a refusal is reported as the room's failure, never remuxed here.
 * Progress and readiness then arrive through the room like any guest's.
 */
export function startTorrentUpload(
  roomID: string,
  mediaGeneration: number,
  { file, session }: TorrentUploadSource,
  onProgress?: (progress: UploadProgress) => void,
  auth?: TorrentAuth,
): void {
  torrentSessions.set(roomID, session)
  if (session.magnet) {
    saveResumableSource(roomID, { kind: 'torrent', fileName: file.name, magnet: session.magnet, filePath: file.path })
  }
  remoteProductions.delete(roomID)
  origins.set(roomID, 'torrent')
  const entry = createEntry(file.size)
  uploads.set(roomID, entry)
  if (onProgress) entry.progressListeners.add((progress) => onProgress({ phase: 'uploading', pct: progress.pct }))
  const release = () => {
    if (torrentSessions.get(roomID) === session) torrentSessions.delete(roomID)
  }
  void startRemoteRemux(roomID, mediaGeneration, session, auth).then((refusal) => {
    if (refusal !== null) {
      lastFailureDetail = refusal
      finishEntry(roomID, entry, REMUX_UNAVAILABLE, () => { release(); session.destroy() })
      return
    }
    remoteProductions.add(roomID)
    if (file.worker) startSubtitleScan(scanJob(roomID, mediaGeneration, file.worker, session))
    lastFailureDetail = null
    finishEntry(roomID, entry, null, () => { release(); session.detach?.() })
  })
}

function scanJob(roomID: string, mediaGeneration: number, grant: WorkerGrant, session: TorrentSession): SubtitleScanJob {
  return {
    roomID,
    mediaGeneration,
    grant,
    sideFiles: session.subtitleFiles.flatMap((side) => side.index === undefined ? []
      : [{ name: side.name, path: side.path, size: side.size, index: side.index }]),
  }
}

// In a worker of its own: no media, no progress entry, and a failure costs
// the room its subtitles but never its video.
function startSubtitleScan(job: SubtitleScanJob): void {
  if (typeof Worker === 'undefined') return
  scanningRooms.add(job.roomID)
  const worker = new Worker(new URL('./pipeline/subtitleWorker.ts', import.meta.url), { type: 'module' })
  const over = () => { scanningRooms.delete(job.roomID); worker.terminate() }
  worker.onmessage = (event: MessageEvent<{ type: string; detail?: string }>) => {
    const message = event.data
    if (message.type === 'trouble') console.error('[subtitle-scan]', message.detail)
    else if (message.type === 'failed') { console.error('[subtitle-scan]', message.detail); over() }
    else if (message.type === 'done') { markSubsDone(job.roomID, job.mediaGeneration); over() }
  }
  worker.onerror = (event) => { console.error('[subtitle-scan]', event.message); over() }
  worker.postMessage({ type: 'start', job })
}

// Completion is remembered per generation so a finished scan is never walked
// twice after a reload.
const scanningRooms = new Set<string>()
const subsDoneKey = (roomID: string, generation: number) => `ss.subs-done.${roomID}.g${generation}`

function markSubsDone(roomID: string, generation: number): void {
  try { localStorage.setItem(subsDoneKey(roomID, generation), '1') } catch {}
}

/**
 * A no-op for anyone but the ex-host, who alone has a resumable source saved.
 * Publishing is idempotent, so a restarted scan costs viewers nothing.
 */
export async function resumeSubtitleScan(roomID: string, mediaGeneration: number): Promise<void> {
  if (scanningRooms.has(roomID) || uploadActive(roomID) || remuxHandleFor(roomID)) return
  try { if (localStorage.getItem(subsDoneKey(roomID, mediaGeneration))) return } catch {}
  const saved = resumableSourceFor(roomID)
  if (!saved || saved.kind !== 'torrent' || !saved.magnet) return
  scanningRooms.add(roomID)
  try {
    const session = await openTorrent(saved.magnet)
    const file = session.files.find((candidate) => candidate.path === saved.filePath) ?? session.files[0]
    if (!file) { session.destroy(); scanningRooms.delete(roomID); return }
    await session.select(file.path)
    if (!file.worker) { session.destroy(); scanningRooms.delete(roomID); return }
    remoteProductions.add(roomID)
    startSubtitleScan(scanJob(roomID, mediaGeneration, file.worker, session))
    session.detach?.()
  } catch (error) {
    scanningRooms.delete(roomID)
    console.error('[subtitle-scan] resume failed', error)
  }
}

// Resolves null on an accepted handoff, or with the reason the fleet said no.
async function startRemoteRemux(
  roomID: string,
  mediaGeneration: number,
  session: TorrentSession,
  auth?: TorrentAuth,
): Promise<string | null> {
  if (mocksEnabled) return null
  if (!session.jobId) return 'torrent session has no fleet job'
  const ownerToken = ownerTokenFor(roomID)
  if (!ownerToken && !auth) return 'no proof of ownership for the room'
  try {
    const response = await fetch(`/api/torrents/${encodeURIComponent(session.jobId)}/remux`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: roomID,
        mediaGeneration,
        requestId: crypto.randomUUID(),
        startMs: 0,
        auth: ownerToken ? { ownerToken } : auth,
      }),
    })
    if (response.status === 202) return null
    const body = await response.json().catch(() => ({})) as { error?: string }
    return `remux refused (${response.status}${body.error ? ` ${body.error}` : ''})`
  } catch (error) {
    return `remux request failed: ${error instanceof Error ? error.message : String(error)}`
  }
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
  cleanup?: () => void
}

/**
 * Remuxes the source here and publishes it into the bucket. Returns at once:
 * whatever goes wrong is reported by name through the registry.
 */
export function startRoomUpload(
  roomID: string,
  mediaGeneration: number,
  source: RemuxSource,
  sideFiles: RemuxSideFile[],
  { onProgress, cleanup = () => {} }: RoomUploadOptions = {},
): void {
  const job: RemuxJob = { roomID, mediaGeneration, source, sideFiles }
  remoteProductions.delete(roomID)
  origins.set(roomID, source.kind === 'file' ? 'file' : 'url')
  const size = sourceSize(source)
  const entry = createEntry(size)
  uploads.set(roomID, entry)
  if (onProgress) entry.progressListeners.add((progress) => onProgress({ phase: 'uploading', pct: progress.pct }))
  let ownHandle: ClientRemuxHandle | null = null
  const dropHandle = () => {
    if (ownHandle && remuxHandles.get(roomID) === ownHandle) remuxHandles.delete(roomID)
  }
  const finish = (error: string | null, detail?: string) => {
    dropHandle()
    lastFailureDetail = error === null ? null : detail ?? null
    finishEntry(roomID, entry, error, cleanup)
  }
  const movedOn = () => {
    if (uploads.get(roomID) === entry) uploads.delete(roomID)
    dropHandle()
    cleanup()
  }
  const onProgressPct = (pct: number) => updateEntry(entry, Math.round((pct / 100) * size))

  if (typeof Worker !== 'undefined' && jobIsCloneable(job)) {
    const worker = new Worker(new URL('./pipeline/remuxWorker.ts', import.meta.url), { type: 'module' })
    ownHandle = { follow: (absoluteMs) => worker.postMessage({ type: 'follow', absoluteMs }) }
    const settle = (fn: () => void) => { fn(); worker.terminate() }
    worker.onmessage = (event: MessageEvent<{ type: string; pct?: number; code?: string; detail?: string; trace?: SeekTrace }>) => {
      const message = event.data
      if (message.type === 'trouble') console.error('[remux-worker]', message.detail)
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
        finish(readFailureCode(cause, source.kind)
          ?? (source.kind === 'url' ? SOURCE_UNREACHABLE : UNSUPPORTED_MEDIA), why)
        return
      }
      console.error('client media pipeline failed', error)
      finish(readFailureCode(error, source.kind) ?? (error instanceof Error ? error.message : 'upload failed'), detail)
    }
  })()
}

// One room prepares at a time in a tab, and only the failure screen asks.
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
