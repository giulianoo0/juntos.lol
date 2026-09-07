import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import type { TorrentSession, TorrentVideoFile } from '../torrent'
import type { DriveEntry } from '../drive'
import { driveErrorKey } from '../driveErrors'
import { StepBack } from '../ui/StepBack'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import { changeRoomSource, startRoomUpload } from '../upload'

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|webm|avi|mov|ogv|ts|m2ts)$/i
const FOLDER_MIME = 'application/vnd.google-apps.folder'

function isFolderEntry(entry: DriveEntry): boolean {
  return entry.mimeType === FOLDER_MIME
}

function isVideoEntry(entry: DriveEntry): boolean {
  if (isFolderEntry(entry)) return false
  const mime = entry.mimeType ?? ''
  return mime.startsWith('video/') || VIDEO_EXTENSION.test(entry.name)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

export interface DriveRoomTarget {
  roomID: string
  memberId: string
  capability: string
}

export interface DriveSideFile {
  name: string
  path: string
  size: number
  url: string
}

export interface DrivePlayback {
  url: string
  sideFiles: DriveSideFile[]
}

/**
 * Resolves a picked Drive file to the ranged googleapis URL the remux reads
 * plus its subtitle sidecars, all preflight-free (key-in-query). Throws when
 * the session cannot name the entry, so callers fail before touching the room.
 */
export async function drivePlaybackUrls(file: TorrentVideoFile, session: TorrentSession): Promise<DrivePlayback> {
  // `drive.ts` pulls mediabunny through driveMediaInput, which must stay out
  // of first paint — hence the dynamic import, here and below.
  const { driveEntryForFile, driveMediaUrl } = await import('../drive')
  const entry = driveEntryForFile(session, file.path)
  if (!entry) throw new Error('drive entry missing for picked file')
  const sideFiles = session.subtitleFiles
    .map((sub) => {
      const subEntry = driveEntryForFile(session, sub.path)
      return subEntry ? { name: sub.name, path: sub.path, size: sub.size, url: driveMediaUrl(subEntry.id) } : null
    })
    .filter((side): side is DriveSideFile => side !== null)
  return { url: driveMediaUrl(entry.id), sideFiles }
}

/**
 * Swaps an existing room onto a Drive pick. The room sees the same
 * `kind='upload'` it sees for torrents; the bytes then remux here through
 * the unchanged `rangeInput` reader (a `url` source builds one in
 * `remuxJob`), with Drive's subtitle sidecars riding along as sidecar URLs.
 * The caller owns the session afterwards and destroys it when the swap
 * throws, exactly like the torrent path.
 */
export async function confirmDrivePick(
  target: DriveRoomTarget,
  file: TorrentVideoFile,
  session: TorrentSession,
): Promise<void> {
  await session.select(file.path)
  const { url, sideFiles } = await drivePlaybackUrls(file, session)
  const next = await changeRoomSource(target.roomID, target.memberId, target.capability, 'upload', file.name)
  startRoomUpload(
    target.roomID,
    next.mediaGeneration,
    { kind: 'url', url, name: file.name, size: file.size },
    sideFiles,
  )
}

interface DrivePickerProps {
  maxFileBytes: number
  onPicked: (file: TorrentVideoFile, session: TorrentSession) => void
  onExit?: () => void
  t: Translator
}

interface FolderLevel {
  id: string
  name: string
  entries: DriveEntry[]
}

interface DriveConfirm {
  file: TorrentVideoFile
  session: TorrentSession
}

/**
 * Owns the Drive session until a video is confirmed, tearing down on unmount
 * what it opened itself; confirming hands the session to the caller, which
 * destroys it when its own swap throws.
 */
export function DrivePicker({ maxFileBytes, onPicked, onExit, t }: DrivePickerProps) {
  const [link, setLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState<TorrentSession | null>(null)
  const [trail, setTrail] = useState<FolderLevel[]>([])
  const [confirm, setConfirm] = useState<DriveConfirm | null>(null)
  const [query, setQuery] = useState('')
  const owned = useRef<TorrentSession | null>(null)
  const extra = useRef<TorrentSession | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const loadRef = useRef<HTMLButtonElement>(null)
  const { shown: waiting, morphing: swapping } = useMorphingStep(loading)
  useMorphingSize(loadRef, waiting, { axis: 'width', durationMs: 260 })

  useEffect(() => () => {
    abortRef.current?.abort()
    owned.current?.destroy()
    extra.current?.destroy()
  }, [])

  const current = trail.length > 0 ? trail[trail.length - 1] : null
  const needle = query.trim().toLowerCase()
  const folders = !current ? [] : current.entries.filter((entry) => isFolderEntry(entry))
    .filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle))
  const videos = !current ? [] : current.entries.filter((entry) => isVideoEntry(entry))
    .filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle))

  const fail = (unknown: unknown) => setError(t(driveErrorKey(unknown)))

  const reset = () => {
    abortRef.current?.abort()
    owned.current?.destroy()
    owned.current = null
    extra.current?.destroy()
    extra.current = null
    setSession(null)
    setTrail([])
    setConfirm(null)
    setQuery('')
    setError('')
  }

  const load = async () => {
    const raw = link.trim()
    if (!raw || loading) return
    // Dynamic import: see drivePlaybackUrls.
    const drive = await import('../drive')
    const parsed = drive.parseDriveLink(raw)
    if (!parsed) {
      setError(t('drive.badLink'))
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    owned.current?.destroy()
    owned.current = null
    extra.current?.destroy()
    extra.current = null
    setSession(null)
    setTrail([])
    setConfirm(null)
    setQuery('')
    setError('')
    setLoading(true)
    try {
      if (parsed.kind === 'file') {
        const info = await drive.fetchDriveMeta(parsed.id, { signal: controller.signal })
        if (!isVideoEntry({ id: info.id, name: info.name, mimeType: info.mimeType, size: info.size })) {
          setError(t('drive.notVideo'))
          return
        }
        const opened = await drive.openDriveSession({ kind: 'file', id: parsed.id }, { signal: controller.signal })
        const file = opened.files[0] ?? null
        if (!file) {
          opened.destroy()
          setError(t('drive.notVideo'))
          return
        }
        if (file.size > maxFileBytes) {
          opened.destroy()
          setError(t('home.tooLarge'))
          return
        }
        owned.current = opened
        setSession(opened)
        setConfirm({ file, session: opened })
      } else {
        const [entries, opened] = await Promise.all([
          drive.listDriveFolder(parsed.id, { signal: controller.signal }),
          drive.openDriveSession({ kind: 'folder', id: parsed.id }, { signal: controller.signal }),
        ])
        owned.current = opened
        setSession(opened)
        setTrail([{ id: parsed.id, name: opened.name || t('drive.folder'), entries }])
      }
    } catch (unknown) {
      if (controller.signal.aborted) return
      fail(unknown)
    } finally {
      if (abortRef.current === controller) setLoading(false)
    }
  }

  const drill = async (entry: DriveEntry) => {
    if (loading) return
    // Dynamic import: see drivePlaybackUrls.
    const drive = await import('../drive')
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setLoading(true)
    try {
      const entries = await drive.listDriveFolder(entry.id, { signal: controller.signal })
      if (controller.signal.aborted) return
      setTrail((prev) => [...prev, { id: entry.id, name: entry.name, entries }])
      setQuery('')
    } catch (unknown) {
      if (controller.signal.aborted) return
      fail(unknown)
    } finally {
      if (abortRef.current === controller) setLoading(false)
    }
  }

  const pickVideo = async (entry: DriveEntry) => {
    const browsing = session
    if (!browsing || !current || loading) return
    setError('')
    setLoading(true)
    let controller: AbortController | null = null
    try {
      const parents = trail.slice(1).map((level) => level.name)
      const treePath = [...parents, entry.name].join('/')
      const direct = browsing.files.find((file) => file.path === treePath) ?? null
      if (direct) {
        if (direct.size > maxFileBytes) {
          setError(t('home.tooLarge'))
          return
        }
        setConfirm({ file: direct, session: browsing })
        return
      }
      // Dynamic import: see drivePlaybackUrls.
      const drive = await import('../drive')
      abortRef.current?.abort()
      controller = new AbortController()
      abortRef.current = controller
      const opened = await drive.openDriveSession({ kind: 'file', id: entry.id }, { signal: controller.signal })
      const first = opened.files[0] ?? null
      if (!first) {
        opened.destroy()
        setError(t('drive.notVideo'))
        return
      }
      if (first.size > maxFileBytes) {
        opened.destroy()
        setError(t('home.tooLarge'))
        return
      }
      extra.current?.destroy()
      extra.current = opened
      setConfirm({ file: first, session: opened })
    } catch (unknown) {
      if (!controller?.signal.aborted) fail(unknown)
    } finally {
      if (controller !== null && abortRef.current === controller) setLoading(false)
    }
  }

  const watch = async () => {
    if (!confirm || loading) return
    setError('')
    setLoading(true)
    try {
      await confirm.session.select(confirm.file.path)
    } catch {
      setError(t('drive.failed'))
      setLoading(false)
      return
    }
    setLoading(false)
    if (owned.current === confirm.session) owned.current = null
    if (extra.current === confirm.session) extra.current = null
    const picked = confirm
    setConfirm(null)
    setSession(null)
    setTrail([])
    setQuery('')
    onPicked(picked.file, picked.session)
  }

  const back = () => {
    if (confirm) {
      setConfirm(null)
      setError('')
      return
    }
    if (trail.length > 1) {
      setTrail((prev) => prev.slice(0, -1))
      setQuery('')
      setError('')
      return
    }
    if (trail.length === 1) {
      reset()
      return
    }
    onExit?.()
  }

  const showBack = confirm !== null || trail.length > 0 || onExit !== undefined
  const title = confirm !== null ? t('drive.confirm') : current !== null ? current.name : t('drive.title')
  const guide = confirm !== null ? t('drive.confirmGuide')
    : current !== null ? t('drive.chooseGuide') : t('drive.guide')

  return (
    <div className="morph-fade">
      <div className="morph-head">
        {showBack ? <StepBack label={t('home.back')} onClick={back} /> : null}
        <h2 className="stage-title">{title}</h2>
      </div>
      <p className="stage-description">{guide}</p>
      {confirm ? (
        <>
          <div className="torrent-summary">
            <strong>{confirm.file.name}</strong>
            <span>{formatBytes(confirm.file.size)}</span>
          </div>
          <div className="torrent-actions">
            <button
              ref={loadRef}
              type="button"
              className={`primary-button torrent-load ${loading ? 'is-loading' : ''}`}
              disabled={loading}
              aria-busy={loading}
              onClick={() => { void watch() }}
            >
              <span className="morph-fade button-label" data-morphing={swapping}>
                {t(waiting ? 'drive.loading' : 'drive.confirmWatch')}
              </span>
            </button>
          </div>
        </>
      ) : !current ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void load()
            }}
          >
            <label htmlFor="drive-link">{t('drive.link')}</label>
            <input
              id="drive-link"
              className="sunken text-field"
              autoFocus
              value={link}
              disabled={loading}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="https://drive.google.com/file/d/…"
              onChange={(event) => setLink(event.target.value)}
            />
            <div className="torrent-actions">
              <button
                ref={loadRef}
                type="submit"
                className={`primary-button torrent-load ${loading ? 'is-loading' : ''}`}
                disabled={loading || !link.trim()}
                aria-busy={loading}
              >
                <span className="morph-fade button-label" data-morphing={swapping}>
                  {t(waiting ? 'drive.loading' : 'drive.load')}
                </span>
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <label className="sr-only" htmlFor="drive-search">{t('drive.search')}</label>
          <input
            id="drive-search"
            className="sunken torrent-search"
            autoFocus
            value={query}
            disabled={loading}
            placeholder={t('drive.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {folders.length + videos.length > 0 ? (
            <div className="torrent-files" aria-busy={loading}>
              {folders.map((entry) => (
                <button type="button" key={entry.id} disabled={loading} onClick={() => { void drill(entry) }}>
                  <span>{entry.name}</span><small>{t('drive.folder')}</small>
                </button>
              ))}
              {videos.map((entry) => (
                <button type="button" key={entry.id} disabled={loading} onClick={() => { void pickVideo(entry) }}>
                  <span>{entry.name}</span><small>{formatBytes(entry.size)}</small>
                </button>
              ))}
            </div>
          ) : <p className="empty-copy torrent-empty">{needle === '' ? t('drive.empty') : t('drive.noMatch')}</p>}
        </>
      )}
      {error ? <div className="error-card torrent-error" role="alert">{error}</div> : null}
    </div>
  )
}
