import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useT } from '../i18n/useT'
import { createRoomAndUpload, createRoomAndUploadTorrent, type UploadProgress } from '../upload'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile } from '../torrent'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024
const HISTORY_KEY = 'ss.room-history.v1'

interface RoomHistoryEntry {
  id: string
  fileName: string
  createdAt: number
}

type PendingMedia =
  | { kind: 'local'; file: File }
  | { kind: 'torrent'; file: TorrentVideoFile; session: TorrentSession }

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

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

function readHistory(): RoomHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    const history = value.filter((entry): entry is RoomHistoryEntry => (
      typeof entry === 'object' && entry !== null &&
      typeof entry.id === 'string' && typeof entry.fileName === 'string' &&
      typeof entry.createdAt === 'number'
    )).map(({ id, fileName, createdAt }) => ({ id, fileName, createdAt })).slice(0, 12)
    // Migrate old entries that included the nickname. Room history never
    // needs identity data and links must remain safe to copy.
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    return history
  } catch {
    return []
  }
}

export function Home() {
  const t = useT()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [nickname, setNickname] = useState(() => localStorage.getItem('ss.nickname') ?? '')
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<RoomHistoryEntry[]>(readHistory)
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null)
  const [draftNickname, setDraftNickname] = useState(nickname)
  const [torrentOpen, setTorrentOpen] = useState(false)
  const [magnet, setMagnet] = useState('')
  const [torrentLoading, setTorrentLoading] = useState(false)
  const [torrentError, setTorrentError] = useState('')
  const [torrentSession, setTorrentSession] = useState<TorrentSession | null>(null)
  const [torrentStats, setTorrentStats] = useState<TorrentStats>(EMPTY_TORRENT_STATS)
  const ownedTorrent = useRef<TorrentSession | null>(null)

  useEffect(() => () => ownedTorrent.current?.destroy(), [])

  const selectFile = (file?: File) => {
    if (!file || starting) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('home.tooLarge'))
      return
    }
    setError('')
    setDraftNickname(nickname)
    setPendingMedia({ kind: 'local', file })
  }

  const closeTorrent = () => {
    ownedTorrent.current?.destroy()
    ownedTorrent.current = null
    setTorrentSession(null)
    setTorrentLoading(false)
    setTorrentError('')
    setTorrentOpen(false)
  }

  const loadTorrent = async () => {
    if (!magnet.trim() || torrentLoading) return
    ownedTorrent.current?.destroy()
    ownedTorrent.current = null
    setTorrentSession(null)
    setTorrentError('')
    setTorrentStats(EMPTY_TORRENT_STATS)
    setTorrentLoading(true)
    try {
      const session = await openTorrent(magnet, setTorrentStats)
      ownedTorrent.current = session
      setTorrentSession(session)
      if (session.files.length === 0) setTorrentError(t('home.torrentNoVideos'))
    } catch {
      setTorrentError(t('home.torrentFailed'))
    } finally {
      setTorrentLoading(false)
    }
  }

  const selectTorrentFile = async (file: TorrentVideoFile) => {
    const session = torrentSession
    if (!session) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setTorrentError(t('home.tooLarge'))
      return
    }
    try {
      await session.select(file.path)
    } catch {
      setTorrentError(t('home.torrentFailed'))
      return
    }
    ownedTorrent.current = null
    setTorrentSession(null)
    setTorrentOpen(false)
    setDraftNickname(nickname)
    setPendingMedia({ kind: 'torrent', file, session })
  }

  const startUpload = async () => {
    const media = pendingMedia
    if (!media || starting) return
    setPendingMedia(null)
    setStarting(true)
    try {
      // Resolves once the room exists and the upload has started; MP4s are
      // converted to MKV first, which is what the preparing state covers.
      const room = media.kind === 'local'
        ? await createRoomAndUpload(media.file, draftNickname.trim(), setProgress)
        : await createRoomAndUploadTorrent({ file: media.file, session: media.session }, draftNickname.trim(), setProgress)
      setNickname(room.nickname)
      localStorage.setItem('ss.nickname', room.nickname)
      const nextHistory = [
        { id: room.roomID, fileName: media.file.name, createdAt: Date.now() },
        ...history.filter((entry) => entry.id !== room.roomID),
      ].slice(0, 12)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))
      setHistory(nextHistory)
      navigate(`/room/${room.roomID}`)
    } catch {
      if (media.kind === 'torrent') media.session.destroy()
      setError(t('home.failed'))
      setStarting(false)
      setProgress(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    selectFile(event.dataTransfer.files[0])
  }

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0])
  }

  return (
    <main className="home-shell">
      <header className="home-header">
        <a className="home-wordmark" href="/">ss.giuli.dev</a>
        <nav aria-label={t('home.navigation')}>
          <button className={!historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(false)}><span aria-hidden="true">＋</span>{t('home.newRoom')}</button>
          <button className={historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(true)}><span aria-hidden="true">↺</span>{t('home.history')}</button>
        </nav>
        <button className="header-language" aria-label={t('home.language')} onClick={() => t.setLanguage(t.language === 'en' ? 'pt-BR' : 'en')}>
          <span aria-hidden="true">{t.language === 'en' ? '🇺🇸' : '🇧🇷'}</span>{t.language === 'en' ? 'EN' : 'PT'}
        </button>
      </header>

      {historyOpen ? (
        <section className="history-panel" aria-labelledby="history-title">
          <header><h1 id="history-title">{t('home.history')}</h1></header>
          {history.length > 0 ? (
            <div className="history-list">
              {history.map((entry) => (
                <Link key={entry.id} to={`/room/${entry.id}`}>
                  <strong>{entry.fileName}</strong>
                  <span>{new Date(entry.createdAt).toLocaleDateString(t.language)}</span>
                </Link>
              ))}
            </div>
          ) : <p className="empty-copy">{t('home.noHistory')}</p>}
        </section>
      ) : (
      <section className="home-stage">
        <div className="home-intro">
          <h1>{t('home.title')}</h1>
          <p>{t('home.guide')}</p>
        </div>
        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input ref={inputRef} hidden type="file" accept="video/*,.mkv" onChange={onChange} />
          <span className="drop-icon" aria-hidden="true">↑</span>
          <strong>{t('home.drop')}</strong>
          <span>{t('home.dropHint')}</span>
          <button className="primary-button raised" onClick={() => inputRef.current?.click()}>{t('home.choose')}</button>
          <button className="torrent-button" onClick={() => setTorrentOpen(true)}><span aria-hidden="true">⌁</span>{t('home.openTorrent')}</button>
        </div>
        {progress?.phase === 'converting' ? (
          <div className="progress-wrap" aria-label={t('home.preparing')}>
            <div className="progress-copy"><span>{t('home.preparing')}</span><span>{progress.pct}%</span></div>
            <div className="progress-track"><span style={{ width: `${progress.pct}%` }} /></div>
          </div>
        ) : null}
        {error ? <div className="error-card" role="alert">{error}</div> : null}
      </section>
      )}
      {torrentOpen ? (
        <dialog className="name-dialog torrent-dialog" open aria-labelledby="torrent-dialog-title" onKeyDown={(event) => {
          if (event.key === 'Escape') closeTorrent()
        }}>
          <form onSubmit={(event) => { event.preventDefault(); void loadTorrent() }}>
            <span className="dialog-file">WebTorrent</span>
            <h2 id="torrent-dialog-title">{torrentSession ? t('home.torrentChooseFile') : t('home.torrentTitle')}</h2>
            <p>{torrentSession ? t('home.torrentChooseGuide') : t('home.torrentGuide')}</p>
            {!torrentSession ? (
              <>
                <label htmlFor="magnet-link">{t('home.magnet')}</label>
                <textarea id="magnet-link" className="sunken magnet-input" autoFocus rows={4} value={magnet} placeholder="magnet:?xt=urn:btih:…" onChange={(event) => setMagnet(event.target.value)} />
                {torrentLoading ? <div className="torrent-loading"><span className="torrent-spinner" aria-hidden="true" />{t('home.torrentMetadata')}</div> : null}
              </>
            ) : (
              <>
                <div className="torrent-summary">
                  <strong>{torrentSession.name}</strong>
                  <span>{torrentStats.peers} {t('home.peers')} · {formatBytes(torrentStats.downloadSpeed)}/s</span>
                </div>
                <div className="torrent-files">
                  {torrentSession.files.map((file) => (
                    <button type="button" key={file.path} onClick={() => { void selectTorrentFile(file) }}>
                      <span>{file.name}</span><small>{formatBytes(file.size)}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            {torrentError ? <div className="error-card torrent-error" role="alert">{torrentError}</div> : null}
            <div className="dialog-actions">
              <button type="button" onClick={closeTorrent}>{t('home.cancel')}</button>
              {!torrentSession ? <button type="submit" className="primary-button" disabled={torrentLoading || !magnet.trim()}>{t('home.torrentLoad')}</button> : null}
            </div>
          </form>
        </dialog>
      ) : null}
      {pendingMedia ? (
        <dialog className="name-dialog" open aria-labelledby="name-dialog-title" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (pendingMedia.kind === 'torrent') pendingMedia.session.destroy()
            setPendingMedia(null)
          }
        }}>
          <form onSubmit={(event) => { event.preventDefault(); void startUpload() }}>
            <span className="dialog-file">{pendingMedia.file.name}</span>
            <h2 id="name-dialog-title">{t('home.dialogTitle')}</h2>
            <p>{t('home.dialogGuide')}</p>
            <label htmlFor="nickname">{t('home.nickname')}</label>
            <input id="nickname" className="sunken" autoFocus value={draftNickname} maxLength={64} placeholder={t('home.nicknamePlaceholder')} onChange={(event) => setDraftNickname(event.target.value)} />
            <div className="dialog-actions">
              <button type="button" onClick={() => {
                if (pendingMedia.kind === 'torrent') pendingMedia.session.destroy()
                setPendingMedia(null)
              }}>{t('home.cancel')}</button>
              <button type="submit" className="primary-button">{t('home.continue')}</button>
            </div>
          </form>
        </dialog>
      ) : null}
    </main>
  )
}
