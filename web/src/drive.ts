/**
 * Google Drive paste-to-watch, 100% in the browser.
 *
 * A pasted Drive link (file or folder) is browsed with the Drive v3 REST API
 * and the picked video plays through the existing client-remux pipeline: byte
 * reads are plain Range GETs on the public `alt=media` download URL, served
 * by the unchanged `rangeInput(url, name, size)` reader.
 *
 * Auth: public anyone-with-link files only, via a browser API key read from
 * the `VITE_GOOGLE_DRIVE_API_KEY` env var (Vite exposes it as
 * `import.meta.env.VITE_GOOGLE_DRIVE_API_KEY`). No user OAuth, no proxy: the
 * browser talks only to `https://www.googleapis.com/drive/v3/...` with the
 * key in the query string plus a `Range` header, both preflight-free.
 *
 * Safety: remote bytes are never executed — they flow only into the
 * mediabunny demuxer through the range reader. Drive strings (file names)
 * must be rendered as React text, never innerHTML. File IDs are validated
 * against DRIVE_ID_RE before any fetch, folder walks are depth- and
 * page-capped, and every fetch takes an AbortSignal.
 */
import { rangeInput, type MediaInput } from './pipeline/mediaInput'
import { isSubtitleFileName } from './subtitleFormats'
import type { TorrentSession, TorrentSideFile, TorrentStats, TorrentVideoFile } from './torrent'

/** Drive file/folder IDs are long URL-safe base64-ish tokens; anything else is never fetched. */
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{25,}$/

export function isDriveId(id: string): boolean {
  return DRIVE_ID_RE.test(id)
}

/** Native Google editors (Docs/Sheets/Slides/...) have no downloadable bytes; v1 rejects them. */
export function isDriveNativeDoc(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.')
    && mimeType !== 'application/vnd.google-apps.folder'
}

export type DriveErrorCode = 'missing-key' | 'bad-id' | 'not-shared' | 'quota' | 'network' | 'unsupported' | 'too-many'

export class DriveError extends Error {
  code: DriveErrorCode
  constructor(code: DriveErrorCode, message: string) {
    super(message)
    this.name = 'DriveError'
    this.code = code
  }
}

/** No `VITE_GOOGLE_DRIVE_API_KEY` configured. */
export class DriveKeyMissingError extends DriveError {
  constructor() {
    super('missing-key', 'Google Drive is not configured (missing API key).')
    this.name = 'DriveKeyMissingError'
  }
}

/** The link is not shared publicly, or the file does not exist. */
export class DriveAccessError extends DriveError {
  constructor() {
    super('not-shared', 'This Drive file is not shared publicly, or it no longer exists.')
    this.name = 'DriveAccessError'
  }
}

/** Drive rate limit / quota spent. Retryable later. */
export class DriveQuotaError extends DriveError {
  constructor() {
    super('quota', 'Google Drive is rate-limiting us right now. Try again in a bit.')
    this.name = 'DriveQuotaError'
  }
}

export class DriveNetworkError extends DriveError {
  constructor() {
    super('network', 'Could not reach Google Drive. Check your connection and try again.')
    this.name = 'DriveNetworkError'
  }
}

/** A native Google Doc/Sheet/Slide was pasted; only real video files play. */
export class DriveUnsupportedError extends DriveError {
  constructor(kind: string) {
    super('unsupported', `This is a Google ${kind}, not a video file. Export or upload it as a video first.`)
    this.name = 'DriveUnsupportedError'
  }
}

function nativeKind(mimeType: string): string {
  if (mimeType.endsWith('.document')) return 'Doc'
  if (mimeType.endsWith('.spreadsheet')) return 'Sheet'
  if (mimeType.endsWith('.presentation')) return 'Slide'
  return 'file'
}

function apiKey(): string {
  const key = (import.meta.env.VITE_GOOGLE_DRIVE_API_KEY as string | undefined)?.trim()
  if (!key) throw new DriveKeyMissingError()
  return key
}

export interface DriveLink {
  kind: 'file' | 'folder'
  id: string
}

/**
 * Pulls the file/folder out of every Drive URL shape: `/file/d/ID/`,
 * `open?id=ID`, `uc?id=ID`, `/drive/folders/ID`, Docs/Sheets/Slides
 * `/d/ID/`, and `/u/N/` account variants of each. A bare pasted ID works
 * too. Null for anything without a strictly valid ID.
 */
export function parseDriveLink(raw: string): DriveLink | null {
  const text = raw.trim()
  if (!text) return null
  if (DRIVE_ID_RE.test(text)) return { kind: 'file', id: text }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (!host.endsWith('.google.com') && host !== 'google.com') return null
  const path = url.pathname

  const folder = /\/folders\/([A-Za-z0-9_-]+)/.exec(path)
  if (folder && isDriveId(folder[1])) return { kind: 'folder', id: folder[1] }

  const file = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(path)
  if (file && isDriveId(file[1])) return { kind: 'file', id: file[1] }

  const doc = /\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(path)
  if (doc && isDriveId(doc[1])) return { kind: 'file', id: doc[1] }

  const param = url.searchParams.get('id')
  if (param && isDriveId(param)) return { kind: 'file', id: param }

  return null
}

export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  size: number
}

export type DriveEntry = DriveFileMeta

const API = 'https://www.googleapis.com/drive/v3'

const BACKOFF_BASE_MS = 300
const API_ATTEMPTS = 3

function backoff(attempt: number): Promise<void> {
  const capped = Math.min(4000, BACKOFF_BASE_MS * 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, capped / 2 + Math.random() * capped / 2))
}

interface DriveApiResult {
  status: number
  json: unknown
}

/** GETs a Drive JSON endpoint, retrying network blips and 5xx up to 3 times with backoff. */
async function driveGet(url: string, signal?: AbortSignal): Promise<DriveApiResult> {
  for (let attempt = 0; attempt < API_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signalAborted()
    let response: Response
    try {
      response = await fetch(url, { signal })
    } catch (error) {
      if (signal?.aborted) throw signalAborted()
      if (attempt + 1 >= API_ATTEMPTS) throw new DriveNetworkError()
      void error
      await backoff(attempt)
      continue
    }
    if (response.status >= 500 && attempt + 1 < API_ATTEMPTS) {
      await response.body?.cancel().catch(() => undefined)
      await backoff(attempt)
      continue
    }
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      json = null
    }
    return { status: response.status, json }
  }
  throw new DriveNetworkError()
}

// Three call sites share this abort shape; one place keeps them in lockstep.
function signalAborted(): Error {
  return new DOMException('aborted', 'AbortError')
}

function driveReason(json: unknown): string {
  if (typeof json !== 'object' || json === null || !('error' in json)) return ''
  const error = json.error
  if (typeof error !== 'object' || error === null || !('errors' in error)) return ''
  const errors = error.errors
  if (!Array.isArray(errors)) return ''
  const first = errors[0]
  if (typeof first !== 'object' || first === null || !('reason' in first)) return ''
  return typeof first.reason === 'string' ? first.reason : ''
}

/** Maps Drive API failures to typed, user-readable errors. */
function throwForStatus(status: number, json: unknown): never {
  const reason = driveReason(json)
  if (
    status === 429
    || reason === 'rateLimitExceeded'
    || reason === 'userRateLimitExceeded'
    || reason === 'quotaExceeded'
    || reason === 'downloadQuotaExceeded'
  ) {
    throw new DriveQuotaError()
  }
  if (status === 400 && (reason === 'badRequest' || reason === 'keyInvalid' || reason === 'API_KEY_INVALID')) {
    throw new DriveKeyMissingError()
  }
  if (status === 401 || status === 403 || status === 404) throw new DriveAccessError()
  throw new DriveNetworkError()
}

function toMeta(json: unknown): DriveFileMeta {
  if (typeof json !== 'object' || json === null) throw new DriveNetworkError()
  const id = 'id' in json ? json.id : undefined
  const name = 'name' in json ? json.name : undefined
  const mimeType = 'mimeType' in json ? json.mimeType : undefined
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mimeType !== 'string') {
    throw new DriveNetworkError()
  }
  const rawSize = 'size' in json ? json.size : undefined
  const size = typeof rawSize === 'string' ? Number(rawSize) : 0
  return { id, name, mimeType, size: Number.isFinite(size) ? size : 0 }
}

/** Metadata for one file; rejects native Google-doc types (no downloadable bytes). */
export async function fetchDriveMeta(id: string, opts?: { signal?: AbortSignal }): Promise<DriveFileMeta> {
  if (!isDriveId(id)) throw new DriveError('bad-id', 'That Drive link has no usable file ID.')
  const key = apiKey()
  const fields = encodeURIComponent('id,name,mimeType,size,parents')
  const url = `${API}/files/${id}?key=${encodeURIComponent(key)}&supportsAllDrives=true&fields=${fields}`
  const { status, json } = await driveGet(url, opts?.signal)
  if (status !== 200) throwForStatus(status, json)
  const meta = toMeta(json)
  if (isDriveNativeDoc(meta.mimeType)) throw new DriveUnsupportedError(nativeKind(meta.mimeType))
  return meta
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

const MAX_FOLDER_PAGES = 10
const FOLDER_PAGE_SIZE = 1000

/** Direct children of a folder, across up to 10 pages of 1000 entries. Unfiltered. */
export async function listDriveFolder(id: string, opts?: { signal?: AbortSignal }): Promise<DriveEntry[]> {
  if (!isDriveId(id)) throw new DriveError('bad-id', 'That Drive link has no usable folder ID.')
  const key = apiKey()
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size)')
  const query = encodeURIComponent(`'${id}' in parents and trashed = false`)
  const out: DriveEntry[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
    const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    const url =
      `${API}/files?key=${encodeURIComponent(key)}&supportsAllDrives=true&includeItemsFromAllDrives=true`
      + `&pageSize=${FOLDER_PAGE_SIZE}&fields=${fields}&q=${query}${token}&orderBy=folder`
    const { status, json } = await driveGet(url, opts?.signal)
    if (status !== 200) throwForStatus(status, json)
    const body = typeof json === 'object' && json !== null ? json : null
    const files = body !== null && 'files' in body && Array.isArray(body.files) ? body.files : []
    for (const item of files) {
      try {
        out.push(toMeta(item))
      } catch {
        continue
      }
    }
    const next = body !== null && 'nextPageToken' in body ? body.nextPageToken : null
    pageToken = typeof next === 'string' && next ? next : null
    if (!pageToken) break
  }
  return out
}

/** Public download URL for a file's bytes; the key rides in the query so reads stay preflight-free. */
export function driveMediaUrl(id: string): string {
  if (!isDriveId(id)) throw new DriveError('bad-id', 'That Drive link has no usable file ID.')
  const key = apiKey()
  return `${API}/files/${id}?alt=media&key=${encodeURIComponent(key)}&supportsAllDrives=true`
}

/**
 * The pipeline input for a Drive file: the unchanged rangeInput reader over
 * the public download URL, so mediabunny gets the same resume/retry Range
 * behavior as every other remote origin.
 */
export function driveMediaInput(entry: DriveEntry): MediaInput {
  return rangeInput(driveMediaUrl(entry.id), entry.name, entry.size)
}

// Mirrors remoteTorrent: video extensions that can play, sidecar cap for subtitles.
const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
const MAX_TREE_DEPTH = 10
const MAX_TREE_ENTRIES = 5000

/** Resolves a session file path back to its Drive entry (Room wiring needs the ID for byte reads). */
const sessionEntries = new WeakMap<TorrentSession, Map<string, DriveEntry>>()

export function driveEntryForFile(session: TorrentSession, path: string): DriveEntry | undefined {
  return sessionEntries.get(session)?.get(path)
}

export interface OpenDriveSessionOptions {
  signal?: AbortSignal
}

interface TreeFile {
  entry: DriveEntry
  path: string
}

/** Breadth-first folder walk, capped at depth 10; returns every entry with its tree path. */
async function collectTree(rootId: string, signal?: AbortSignal): Promise<TreeFile[]> {
  const out: TreeFile[] = []
  const queue: Array<{ id: string; prefix: string; depth: number }> = [{ id: rootId, prefix: '', depth: 0 }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || next.depth > MAX_TREE_DEPTH) continue
    const children = await listDriveFolder(next.id, { signal })
    for (const child of children) {
      // Total cap: depth-capped but wide adversarial trees must fail loud,
      // never pile unbounded entries into memory mid-walk.
      if (out.length >= MAX_TREE_ENTRIES) throw new DriveError('too-many', 'This Drive folder is too large to browse.')
      const path = next.prefix ? `${next.prefix}/${child.name}` : child.name
      out.push({ entry: child, path })
      if (child.mimeType === DRIVE_FOLDER_MIME && next.depth + 1 <= MAX_TREE_DEPTH) {
        queue.push({ id: child.id, prefix: path, depth: next.depth + 1 })
      }
    }
  }
  return out
}

function toVideoFile(entry: DriveEntry, path: string, index: number): TorrentVideoFile {
  return {
    name: entry.name,
    path,
    index,
    size: entry.size,
    type: 'application/octet-stream',
    progress: 1,
    downloaded: entry.size,
  }
}

function toSideFile(entry: DriveEntry, path: string): TorrentSideFile {
  return { name: entry.name, path, size: entry.size }
}

function buildSession(name: string, videos: TreeFile[], subtitles: TreeFile[], controller: AbortController): TorrentSession {
  const ordered = [...videos].sort((a, b) => b.entry.size - a.entry.size)
  const files = ordered.map((video, index) => toVideoFile(video.entry, video.path, index))
  const subtitleFiles = subtitles.map((sub) => toSideFile(sub.entry, sub.path))
  const total = files.reduce((sum, file) => sum + file.size, 0)
  let destroyed = false
  const byPath = new Map(ordered.map((video) => [video.path, video.entry]))
  for (const sub of subtitles) {
    if (!byPath.has(sub.path)) byPath.set(sub.path, sub.entry)
  }
  const session: TorrentSession = {
    name,
    files,
    subtitleFiles,
    stats: (): TorrentStats => ({ peers: 0, downloadSpeed: 0, downloaded: total, progress: 1 }),
    select: async (path: string): Promise<void> => {
      const found = files.find((candidate) => candidate.path === path)
      if (!found) throw new Error('drive file not found')
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      controller.abort()
    },
    detach: () => {
      if (destroyed) return
      destroyed = true
      controller.abort()
    },
  }
  sessionEntries.set(session, byPath)
  return session
}

/**
 * Opens a pasted link as a TorrentSession-shaped object so the room reuses
 * the `kind='upload'` path: file links resolve to the single video (plus
 * same-folder subtitle sidecars via the parent), folder links collect every
 * video in the tree (depth <= 10).
 */
export async function openDriveSession(
  ref: DriveLink,
  opts?: OpenDriveSessionOptions,
): Promise<TorrentSession> {
  if (!isDriveId(ref.id)) throw new DriveError('bad-id', 'That Drive link has no usable file ID.')
  const controller = new AbortController()
  const signal = opts?.signal
  if (signal?.aborted) throw signalAborted()
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  if (ref.kind === 'file') {
    const meta = await fetchDriveMeta(ref.id, { signal: controller.signal })
    if (meta.mimeType === DRIVE_FOLDER_MIME) {
      return openDriveSession({ kind: 'folder', id: meta.id }, opts)
    }
    let subtitles: TreeFile[] = []
    try {
      const parents = await driveParents(ref.id, controller.signal)
      if (parents.length > 0) {
        const siblings = await listDriveFolder(parents[0], { signal: controller.signal })
        subtitles = siblings
          .filter((sib) => sib.id !== meta.id && isSubtitleFileName(sib.name) && sib.size > 0 && sib.size <= MAX_SIDE_FILE_BYTES)
          .map((sib) => ({ entry: sib, path: sib.name }))
      }
    } catch {
      subtitles = []
    }
    const video: TreeFile = { entry: meta, path: meta.name }
    return buildSession(meta.name, [video], subtitles, controller)
  }
  const meta = await driveMetaBestEffort(ref.id, controller.signal)
  const tree = await collectTree(ref.id, controller.signal)
  const videos = tree.filter((item) => item.entry.mimeType !== DRIVE_FOLDER_MIME && VIDEO_EXTENSION.test(item.entry.name))
  const subtitles = tree.filter(
    (item) => item.entry.mimeType !== DRIVE_FOLDER_MIME && isSubtitleFileName(item.entry.name) && item.entry.size > 0 && item.entry.size <= MAX_SIDE_FILE_BYTES,
  )
  return buildSession(meta?.name ?? 'Google Drive', videos, subtitles, controller)
}

async function driveParents(id: string, signal?: AbortSignal): Promise<string[]> {
  const key = apiKey()
  const fields = encodeURIComponent('parents')
  const url = `${API}/files/${id}?key=${encodeURIComponent(key)}&supportsAllDrives=true&fields=${fields}`
  const { status, json } = await driveGet(url, signal)
  if (status !== 200 || typeof json !== 'object' || json === null || !('parents' in json)) return []
  if (!Array.isArray(json.parents)) return []
  return json.parents.filter((p): p is string => typeof p === 'string' && isDriveId(p))
}

async function driveMetaBestEffort(id: string, signal?: AbortSignal): Promise<DriveFileMeta | null> {
  try {
    const key = apiKey()
    const fields = encodeURIComponent('id,name,mimeType')
    const url = `${API}/files/${id}?key=${encodeURIComponent(key)}&supportsAllDrives=true&fields=${fields}`
    const { status, json } = await driveGet(url, signal)
    if (status !== 200) return null
    return toMeta(json)
  } catch {
    return null
  }
}
