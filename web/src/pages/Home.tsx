import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { History, MonitorUp, Plus, Upload, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { isScreenShareCancelled, requestScreenStream, stashScreenStream } from '../screenshare'
import { createRoomAndUpload, createRoomAndUploadTorrent, createScreenRoom, isUnreadableFile, type UploadProgress } from '../upload'
import { TorrentPicker } from '../components/TorrentPicker'
import type { TorrentSession, TorrentVideoFile } from '../torrent'

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
  // The screen is granted before the room exists, so the pending pick carries
  // the live stream through the nickname step.
  | { kind: 'screen'; stream: MediaStream }

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
  const [historyStatus, setHistoryStatus] = useState<Record<string, 'checking' | 'live' | 'expired'>>({})

  // A room outlives its history entry by only a few hours, so the entry alone
  // says nothing about whether the link still works. Ask the server.
  useEffect(() => {
    if (!historyOpen || history.length === 0) return
    const controller = new AbortController()
    setHistoryStatus(Object.fromEntries(history.map((entry) => [entry.id, 'checking' as const])))
    for (const entry of history) {
      void fetch(`/api/rooms/${encodeURIComponent(entry.id)}`, { signal: controller.signal })
        .then((response) => {
          setHistoryStatus((current) => ({ ...current, [entry.id]: response.ok ? 'live' : 'expired' }))
        })
        .catch(() => {
          // A network failure says nothing about the room, so claim nothing.
          setHistoryStatus((current) => {
            const next = { ...current }
            delete next[entry.id]
            return next
          })
        })
    }
    return () => controller.abort()
  }, [historyOpen, history])

  // The picker has to open inside this click, and before any room is created:
  // closing it then leaves nothing behind.
  const startScreenRoom = () => {
    void requestScreenStream().then((stream) => {
      setError('')
      setDraftNickname(nickname)
      setPendingMedia({ kind: 'screen', stream })
    }).catch((error: unknown) => {
      if (!isScreenShareCancelled(error)) setError(t('error.screenshare'))
    })
  }

  const discardPending = (media: PendingMedia | null) => {
    if (media?.kind === 'torrent') media.session.destroy()
    if (media?.kind === 'screen') media.stream.getTracks().forEach((track) => track.stop())
  }

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
        : media.kind === 'torrent'
          ? await createRoomAndUploadTorrent({ file: media.file, session: media.session }, draftNickname.trim(), setProgress)
          : await createScreenRoom(draftNickname.trim())
      if (media.kind === 'screen') stashScreenStream(room.roomID, media.stream)
      setNickname(room.nickname)
      localStorage.setItem('ss.nickname', room.nickname)
      const nextHistory = [
        { id: room.roomID, fileName: media.kind === 'screen' ? t('room.screenLabel') : media.file.name, createdAt: Date.now() },
        ...history.filter((entry) => entry.id !== room.roomID),
      ].slice(0, 12)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))
      setHistory(nextHistory)
      navigate(`/room/${room.roomID}`)
    } catch (error) {
      discardPending(media)
      // A file that changed under the picker is not a failed transfer, and
      // saying "try again" would send someone straight back into it.
      setError(t(isUnreadableFile(error) ? 'error.fileChanged' : 'home.failed'))
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
          <button className={!historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(false)}><Plus size={15} aria-hidden="true" />{t('home.newRoom')}</button>
          <button className={historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(true)}><History size={15} aria-hidden="true" />{t('home.history')}</button>
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
                  <span className="history-meta">
                    {historyStatus[entry.id] ? (
                      <span className={`history-status is-${historyStatus[entry.id]}`}>
                        {t(`home.history${historyStatus[entry.id] === 'live' ? 'Live' : historyStatus[entry.id] === 'expired' ? 'Expired' : 'Checking'}`)}
                      </span>
                    ) : null}
                    <span>{new Date(entry.createdAt).toLocaleDateString(t.language)}</span>
                  </span>
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
          <Upload className="drop-icon" size={34} strokeWidth={1.6} aria-hidden="true" />
          <strong>{t('home.drop')}</strong>
          <span>{t('home.dropHint')}</span>
          <div className="drop-actions">
            <button className="primary-button raised" onClick={() => inputRef.current?.click()}>{t('home.choose')}</button>
            <button className="torrent-button" onClick={() => setTorrentOpen(true)}>
              <span className="magnet-glyph" aria-hidden="true">µ</span>{t('home.openTorrent')}
            </button>
            <button className="torrent-button" onClick={startScreenRoom}>
              <MonitorUp size={16} aria-hidden="true" />{t('home.shareScreen')}
            </button>
          </div>
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
          if (event.key === 'Escape') setTorrentOpen(false)
        }}>
          <div className="dialog-body">
            <button type="button" className="dialog-close" aria-label={t('home.closeDialog')} onClick={() => setTorrentOpen(false)}>
              <X size={16} />
            </button>
            <TorrentPicker maxFileBytes={MAX_UPLOAD_BYTES} t={t} onPicked={(file, session) => {
              setTorrentOpen(false)
              setDraftNickname(nickname)
              setPendingMedia({ kind: 'torrent', file, session })
            }} />
          </div>
        </dialog>
      ) : null}
      {pendingMedia ? (
        <dialog className="name-dialog" open aria-labelledby="name-dialog-title" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            discardPending(pendingMedia)
            setPendingMedia(null)
          }
        }}>
          <form onSubmit={(event) => { event.preventDefault(); void startUpload() }}>
            <span className="dialog-file">{pendingMedia.kind === 'screen' ? t('home.screenDialog') : pendingMedia.file.name}</span>
            <h2 id="name-dialog-title">{t('home.dialogTitle')}</h2>
            <p>{t('home.dialogGuide')}</p>
            <label htmlFor="nickname">{t('home.nickname')}</label>
            <input id="nickname" className="sunken" autoFocus value={draftNickname} maxLength={64} placeholder={t('home.nicknamePlaceholder')} onChange={(event) => setDraftNickname(event.target.value)} />
            <div className="dialog-actions">
              <button type="button" onClick={() => {
                discardPending(pendingMedia)
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
