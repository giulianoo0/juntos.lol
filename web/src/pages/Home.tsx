import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { History, MonitorUp, Upload } from 'lucide-react'
import { useT } from '../i18n/useT'
import { isScreenShareCancelled, requestScreenStream, stashScreenStream } from '../screenshare'
import { createRoomAndUpload, createRoomAndUploadTorrent, createScreenRoom, isUnreadableFile, type UploadProgress } from '../upload'
import { BuildInfo } from '../components/BuildInfo'
import { TorrentPicker } from '../components/TorrentPicker'
import { Button } from '../ui/Button'
import { Dialog, DialogContent } from '../ui/Dialog'
import type { TorrentSession, TorrentVideoFile } from '../torrent'
import { CatalogBrowser } from '../catalog/CatalogBrowser'
import { MetaDetails, type TitlePick } from '../catalog/MetaDetails'
import { openCatalogStream } from '../catalog/openStream'
import { nowPlayingFromPick, nowPlayingKey } from '../catalog/NextEpisode'
import type { CatalogMeta, MetaType } from '../catalog/cinemeta'
import type { TitleOpen } from '../catalog/PosterCard'

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
  // A catalog pick: the torrent only opens after the nickname is confirmed.
  | { kind: 'stream'; pick: TitlePick }

// The morph origin travels through router state, which must be serializable —
// a live DOMRect is not.
interface TitleLocationState {
  meta?: CatalogMeta
  rect?: { top: number; left: number; width: number; height: number }
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

function isMetaType(value: string | undefined): value is MetaType {
  return value === 'movie' || value === 'series'
}

export function Home() {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams<{ type?: string; id?: string }>()
  const location = useLocation()
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
  const [manualOpen, setManualOpen] = useState<false | 'menu' | 'file'>(false)
  const [torrentOpen, setTorrentOpen] = useState(false)
  const [historyStatus, setHistoryStatus] = useState<Record<string, 'checking' | 'live' | 'expired'>>({})
  const [startingLabel, setStartingLabel] = useState('')

  // The details panel is URL-driven: /title/:type/:id renders it over the
  // board, so every title is deep-linkable. A click also stashes the poster's
  // rect (and full meta) in router state, which the morph grows out of; a
  // direct visit has neither and fades in instead.
  const state = (location.state ?? {}) as TitleLocationState
  const detailsOpen: TitleOpen | null = isMetaType(params.type) && params.id
    ? {
      meta: state.meta?.id === params.id ? state.meta : { id: params.id, type: params.type, name: state.meta?.name ?? '', poster: '', releaseInfo: '' },
      rect: state.rect ? new DOMRect(state.rect.left, state.rect.top, state.rect.width, state.rect.height) : undefined,
    }
    : null

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
    setManualOpen(false)
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
    setManualOpen(false)
    setDraftNickname(nickname)
    setPendingMedia({ kind: 'local', file })
  }

  const openTitle = (open: TitleOpen) => {
    const rect = open.rect
      ? { top: open.rect.top, left: open.rect.left, width: open.rect.width, height: open.rect.height }
      : undefined
    navigate(`/title/${open.meta.type}/${encodeURIComponent(open.meta.id)}`, { state: { meta: open.meta, rect } })
  }

  const closeTitle = () => {
    navigate('/', { state: null })
  }

  const pickStream = (pick: TitlePick) => {
    setError('')
    setDraftNickname(nickname)
    setPendingMedia({ kind: 'stream', pick })
  }

  const startUpload = async () => {
    const media = pendingMedia
    if (!media || starting) return
    setPendingMedia(null)
    setStarting(true)
    setStartingLabel(
      media.kind === 'screen' ? t('room.screenLabel')
        : media.kind === 'stream' ? media.pick.displayName
          : media.file.name,
    )
    try {
      // Resolves once the room exists and the upload has started; MP4s are
      // converted to MKV first, which is what the preparing state covers.
      let room
      let fileName = ''
      if (media.kind === 'local') {
        room = await createRoomAndUpload(media.file, draftNickname.trim(), setProgress)
        fileName = media.file.name
      } else if (media.kind === 'torrent') {
        room = await createRoomAndUploadTorrent({ file: media.file, session: media.session }, draftNickname.trim(), setProgress)
        fileName = media.file.name
      } else if (media.kind === 'stream') {
        // The details panel sits over the whole page; leaving it up would
        // hide the progress (and any error) that comes next.
        closeTitle()
        // Opening the torrent is part of the start: peers and metadata first,
        // then the room, so a dead stream never leaves an empty room behind.
        setProgress({ phase: 'converting', pct: 0 })
        const opened = await openCatalogStream(media.pick.stream)
        setProgress(null)
        try {
          room = await createRoomAndUploadTorrent(opened, draftNickname.trim(), setProgress)
        } catch (error) {
          opened.session.destroy()
          throw error
        }
        fileName = media.pick.displayName
        // Remember what the fresh room is playing, so the episode's end can
        // offer the next one.
        const playing = nowPlayingFromPick(media.pick)
        try {
          if (playing) localStorage.setItem(nowPlayingKey(room.roomID), JSON.stringify(playing))
        } catch { /* private mode */ }
      } else {
        room = await createScreenRoom(draftNickname.trim())
        fileName = t('room.screenLabel')
      }
      if (media.kind === 'screen') stashScreenStream(room.roomID, media.stream)
      setNickname(room.nickname)
      localStorage.setItem('ss.nickname', room.nickname)
      const nextHistory = [
        { id: room.roomID, fileName, createdAt: Date.now() },
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
    <main className="home-shell catalog-shell">
      <header className="home-header">
        <a className="home-wordmark" href="/">ss.giuli.dev</a>
        <nav aria-label={t('home.navigation')}>
          <button className={!historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(false)}>{t('catalog.tab')}</button>
          <button onClick={() => setManualOpen('menu')}><Upload size={15} aria-hidden="true" />{t('home.uploadManually')}</button>
          <button className={historyOpen ? 'is-active' : ''} onClick={() => setHistoryOpen(true)}><History size={15} aria-hidden="true" />{t('home.history')}</button>
        </nav>
        <div className="header-end">
          <BuildInfo label={t('home.source')} />
          <button className="header-language" aria-label={t('home.language')} onClick={() => t.setLanguage(t.language === 'en' ? 'pt-BR' : 'en')}>
            <span aria-hidden="true">{t.language === 'en' ? '🇺🇸' : '🇧🇷'}</span>{t.language === 'en' ? 'EN' : 'PT'}
          </button>
        </div>
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
        <section className="catalog-stage">
          <CatalogBrowser onOpenTitle={openTitle} hideSearch={detailsOpen !== null} />
          {error ? <div className="error-card" role="alert">{error}</div> : null}
        </section>
      )}

      {/* The page fades under this and the preparing state fades in over it,
          instead of the dialog just vanishing as if something broke. */}
      <AnimatePresence>
        {starting ? (
          <motion.div
            className="starting-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
            role="status"
            aria-live="polite"
          >
            <motion.div
              className="starting-card"
              initial={{ opacity: 0, transform: 'translateY(14px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ duration: 0.35, delay: 0.15, ease: [0.23, 1, 0.32, 1] }}
            >
              <span className="player-spinner" aria-hidden="true" />
              <h2>{t('home.preparing')}</h2>
              <p className="starting-file">{startingLabel}</p>
              <p className="starting-phase">
                {progress?.phase === 'converting' && progress.pct > 0
                  ? `${progress.pct}%`
                  : t('catalog.opening')}
              </p>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {detailsOpen ? (
        <MetaDetails
          key={`${detailsOpen.meta.type}:${detailsOpen.meta.id}`}
          open={detailsOpen}
          mode="create"
          onClose={closeTitle}
          onPickStream={pickStream}
        />
      ) : null}

      <Dialog open={manualOpen !== false} onOpenChange={(open) => { if (!open) setManualOpen(false) }}>
        {manualOpen !== false ? (
          <DialogContent
            className={manualOpen === 'file' ? 'upload-dialog' : ''}
            closeLabel={t('home.closeDialog')}
            title={t('home.uploadManually')}
            description={manualOpen === 'menu' ? t('home.uploadGuide') : t('home.dropHint')}
          >
            {manualOpen === 'menu' ? (
              <div className="source-options">
                <button onClick={() => setManualOpen('file')}>
                  <Upload size={18} aria-hidden="true" />{t('home.uploadFile')}
                </button>
                <button onClick={startScreenRoom}>
                  <MonitorUp size={18} aria-hidden="true" />{t('home.shareScreen')}
                </button>
              </div>
            ) : (
              <div
                className={`drop-zone dialog-drop ${dragging ? 'is-dragging' : ''}`}
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
                  <button className="torrent-button" onClick={() => { setManualOpen(false); setTorrentOpen(true) }}>
                    <span className="magnet-glyph" aria-hidden="true">µ</span>{t('home.openTorrent')}
                  </button>
                </div>
                {error ? <div className="error-card" role="alert">{error}</div> : null}
              </div>
            )}
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={torrentOpen} onOpenChange={setTorrentOpen}>
        {torrentOpen ? (
          <DialogContent
            className="torrent-dialog"
            closeLabel={t('home.closeDialog')}
            hideTitle
            title={t('home.torrentTitle')}
          >
            <TorrentPicker maxFileBytes={MAX_UPLOAD_BYTES} t={t} onPicked={(file, session) => {
              setTorrentOpen(false)
              setDraftNickname(nickname)
              setPendingMedia({ kind: 'torrent', file, session })
            }} />
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={pendingMedia !== null}
        onOpenChange={(open) => {
          if (open || !pendingMedia) return
          discardPending(pendingMedia)
          setPendingMedia(null)
        }}
      >
        {pendingMedia ? (
          <DialogContent
            closeLabel={t('home.closeDialog')}
            title={t('home.dialogTitle')}
            description={t('home.dialogGuide')}
          >
            <span className="dialog-file">
              {pendingMedia.kind === 'screen' ? t('home.screenDialog')
                : pendingMedia.kind === 'stream' ? pendingMedia.pick.displayName
                  : pendingMedia.file.name}
            </span>
            <form onSubmit={(event) => { event.preventDefault(); void startUpload() }}>
              <label htmlFor="nickname">{t('home.nickname')}</label>
              <input id="nickname" className="sunken" autoFocus value={draftNickname} maxLength={64} placeholder={t('home.nicknamePlaceholder')} onChange={(event) => setDraftNickname(event.target.value)} />
              <div className="dialog-actions">
                <Button onClick={() => {
                  discardPending(pendingMedia)
                  setPendingMedia(null)
                }}>{t('home.cancel')}</Button>
                <Button type="submit" variant="primary">{t('home.continue')}</Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </main>
  )
}
