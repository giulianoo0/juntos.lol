import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Room as LiveKitRoom } from 'livekit-client'
import { Chat } from '../chat/Chat'
import { StatusPill } from '../components/StatusPill'
import { UploadAvailability } from '../components/UploadAvailability'
import { useT, type Translator } from '../i18n/useT'
import { Player } from '../player/Player'
import { useSync } from '../player/useSync'
import { startScreenShare } from '../screenshare'
import type { ChatEntry, PresenceEvent, RoomInfo } from '../types'
import { TorrentPicker } from '../components/TorrentPicker'
import type { TorrentSession, TorrentVideoFile } from '../torrent'
import { MAX_UPLOAD_BYTES } from './Home'
import {
  changeRoomSource,
  prepareLocalFile,
  subscribeUploadDone,
  subscribeUploadProgress,
  uploadFileToRoom,
  uploadTorrentToRoom,
  type RoomUploadProgress,
} from '../upload'

// How long one arrival or departure stays on screen before the next is shown.
const PRESENCE_TOAST_MS = 4_000
const MAX_VISIBLE_TOASTS = 3

export function RoomPage() {
  const { id = '' } = useParams()
  const [nickname, setNickname] = useState(() => localStorage.getItem('ss.nickname') || '')
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    // Old shared links may still contain ?nick=. Remove every query parameter
    // before it can linger in browser history, referrers, or screenshots.
    if (window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/rooms/${encodeURIComponent(id)}`, { signal: controller.signal }).then(async (response) => {
      if (response.status === 404) { setMissing(true); return }
      if (!response.ok) throw new Error('room request failed')
      setRoom(await response.json() as RoomInfo)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setMissing(true)
    })
    return () => controller.abort()
  }, [id])

  if (missing) return <EmptyRoom />
  if (!room) return <main className="center-state"><StatusPill status="connecting" label="Connecting" /></main>
  if (!nickname) {
    return <JoinRoom onJoin={(value) => { localStorage.setItem('ss.nickname', value); setNickname(value) }} />
  }
  return <ConnectedRoom room={room} nickname={nickname} />
}

// The room link is the whole invitation: whoever opens it is already in, and
// the only thing still missing is what to call them.
function JoinRoom({ onJoin }: { onJoin: (nickname: string) => void }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  return (
    <main className="center-state">
      <form className="state-card raised join-card" onSubmit={(event) => {
        event.preventDefault()
        onJoin(draft.trim() || guestName())
      }}>
        <h1>{t('room.joinTitle')}</h1>
        <p>{t('room.joinGuide')}</p>
        <label htmlFor="join-nickname">{t('home.nickname')}</label>
        <input
          id="join-nickname"
          className="sunken text-field"
          autoFocus
          value={draft}
          maxLength={64}
          placeholder={t('home.nicknamePlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary-button">{t('room.join')}</button>
      </form>
    </main>
  )
}

// Mirrors the guest name the server hands out when a room is created, so a
// blank field is a valid answer here too.
function guestName(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const random = crypto.getRandomValues(new Uint8Array(6))
  return `Guest-${Array.from(random, (value) => alphabet[value % alphabet.length]).join('')}`
}

function ConnectedRoom({ room, nickname }: { room: RoomInfo; nickname: string }) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const remoteTileRef = useRef<HTMLDivElement>(null)
  const sync = useSync(room.id, nickname, videoRef)
  const [liveRoom, setLiveRoom] = useState(room)
  const [chatOpen, setChatOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const [shareRoom, setShareRoom] = useState<LiveKitRoom | null>(null)
  const [shareError, setShareError] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<RoomUploadProgress | null>(null)
  const [uploadFailed, setUploadFailed] = useState(false)
  const mediaStatus = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status
  const toasts = usePresenceToasts(sync.presence)
  const [sourcePanel, setSourcePanel] = useState<'menu' | 'torrent' | null>(null)
  const [sourceError, setSourceError] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isScreenRoom = liveRoom.sourceKind === 'screen'

  // Repointing the room is the controller's call alone; the server enforces it
  // too, so a stale client cannot swap what everyone is watching.
  const swapSource = async (run: () => Promise<void>) => {
    setSourceError(false)
    setSourcePanel(null)
    try {
      await run()
    } catch (error) {
      console.error('change source failed', error)
      setSourceError(true)
    }
  }

  const chooseFile = (file?: File) => {
    if (!file) return
    void swapSource(async () => {
      const prepared = await prepareLocalFile(file)
      const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', prepared.name)
      uploadFileToRoom(room.id, next.uploadEndpoint, next.streamStartBytes, prepared)
    })
  }

  const chooseTorrent = (file: TorrentVideoFile, session: TorrentSession) => {
    void swapSource(async () => {
      const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', file.name)
      uploadTorrentToRoom(room.id, next.uploadEndpoint, next.streamStartBytes, { file, session })
    })
  }

  const chooseScreen = () => {
    void swapSource(async () => {
      await changeRoomSource(room.id, sync.memberId, sync.capability, 'screen')
    })
  }

  // Presence is woven into the chat timeline so someone who was away can still
  // read who arrived while the toast was on screen.
  const chatEntries = useMemo((): ChatEntry[] => [
    ...sync.messages,
    ...sync.presence.map((event) => ({
      author: event.nickname,
      text: t(event.kind === 'join' ? 'presence.joined' : 'presence.left'),
      at: event.at,
      system: true,
    })),
    // Server timestamps carry an offset and client ones are UTC, so the two
    // are only comparable once parsed.
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)), [sync.messages, sync.presence, t])

  // Media and subtitle updates carry the current media status; each signal
  // means fresh room metadata is available.
  useEffect(() => {
    if (sync.roomVersion === 0) return
    const controller = new AbortController()
    void fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal }).then(async (response) => {
      if (response.ok) setLiveRoom(await response.json() as RoomInfo)
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.error('room refetch failed', error)
    })
    return () => controller.abort()
  }, [sync.roomVersion, room.id])

  // Show this tab's own background upload progress while it is running.
  useEffect(() => subscribeUploadProgress(room.id, setUploadProgress), [room.id, liveRoom.mediaGeneration])
  useEffect(() => {
    setUploadFailed(false)
    return subscribeUploadDone(room.id, (error) => {
      setUploadProgress(null)
      if (error) setUploadFailed(true)
    })
  }, [room.id, liveRoom.mediaGeneration])

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/room/${room.id}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const shareScreen = async () => {
    setShareError(false)
    try {
      if (shareRoom) { await shareRoom.disconnect(); setShareRoom(null); return }
      const nextRoom = await startScreenShare(room.id, sync.memberId, sync.capability, (element) => {
        remoteTileRef.current?.replaceChildren(element)
      })
      setShareRoom(nextRoom)
    } catch { setShareError(true) }
  }

  if (uploadFailed) {
    return <main className="center-state"><div className="state-card error-card"><h1>{t('room.uploadFailed')}</h1><Link to="/">{t('room.new')}</Link></div></main>
  }
  if (mediaStatus === 'processing' || mediaStatus === 'uploading') {
    return <main className="center-state"><UploadAvailability progress={uploadProgress} t={t} /></main>
  }
  if (mediaStatus === 'error') {
    return <main className="center-state"><div className="state-card error-card"><h1>{t('room.error')}</h1><p>{liveRoom.errorMessage}</p><Link to="/">{t('room.new')}</Link></div></main>
  }

  return (
    <main className="room-shell">
      <PresenceToasts events={toasts} t={t} />
      <header className="room-header">
        <div className="room-heading"><span className="room-file">{isScreenRoom ? t('room.screenLabel') : liveRoom.fileName}</span></div>
        <div className="header-actions">
          {uploadProgress !== null ? <span className="upload-chip">{t('home.uploading')} {uploadProgress.pct}%</span> : null}
          {uploadFailed ? <span className="upload-chip is-error">{t('room.uploadFailed')}</span> : null}
          <StatusPill status={sync.buffering ? 'buffering' : sync.connected ? 'live' : 'connecting'} label={t(sync.buffering ? 'status.buffering' : sync.connected ? 'status.live' : 'status.connecting')} />
          {sync.isController ? <button onClick={() => { setSourceError(false); setSourcePanel('menu') }}>{t('room.changeSource')}</button> : null}
          <button onClick={copyLink}>{copied ? t('room.copied') : t('room.copy')}</button>
          {!isScreenRoom ? <button onClick={shareScreen}>{shareRoom ? t('room.stopScreen') : t('room.shareScreen')}</button> : null}
          <button onClick={() => setChatOpen((open) => !open)}>{t('chat.title')}</button>
        </div>
      </header>
      {shareError ? <div className="error-card compact">{t('error.screenshare')}</div> : null}
      <div className="room-layout">
        <section className="media-column">
          {isScreenRoom ? (
            <ScreenStage
              roomId={room.id}
              memberId={sync.memberId}
              capability={sync.capability}
              isController={sync.isController}
              t={t}
            />
          ) : (
            <Player room={liveRoom} isController={sync.isController} videoRef={videoRef} send={sync.send} t={t} />
          )}
          <div ref={remoteTileRef} className="screen-tile" />
          <div className="presence-row">
            {sync.members.map((member) => (
              <span key={member.id} className={`member-chip ${member.id === sync.controllerId ? 'is-controller' : ''}`}>
                {member.nickname}{member.id === sync.controllerId ? ' ●' : ''}
              </span>
            ))}
          </div>
        </section>
        <Chat open={chatOpen} onClose={() => setChatOpen(false)} messages={chatEntries} onSend={(text) => sync.send('chat', { text })} t={t} />
      </div>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept="video/*,.mkv"
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />
      {sourceError ? <div className="error-card compact" role="alert">{t('room.changeFailed')}</div> : null}
      {sourcePanel !== null ? (
        <dialog className="name-dialog torrent-dialog" open aria-labelledby="source-dialog-title" onKeyDown={(event) => {
          if (event.key === 'Escape') setSourcePanel(null)
        }}>
          <div className="dialog-body">
            {sourcePanel === 'menu' ? (
              <>
                <span className="dialog-file">{isScreenRoom ? t('room.screenLabel') : liveRoom.fileName}</span>
                <h2 id="source-dialog-title">{t('room.changeSourceTitle')}</h2>
                <p>{t('room.changeSourceGuide')}</p>
                <div className="source-options">
                  <button type="button" onClick={() => { setSourcePanel(null); fileInputRef.current?.click() }}>
                    <span aria-hidden="true">↑</span>{t('room.sourceFile')}
                  </button>
                  <button type="button" onClick={() => setSourcePanel('torrent')}>
                    <span aria-hidden="true">⌁</span>{t('room.sourceTorrent')}
                  </button>
                  <button type="button" onClick={chooseScreen}>
                    <span aria-hidden="true">⧉</span>{t('room.sourceScreen')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="dialog-file">WebTorrent</span>
                <TorrentPicker maxFileBytes={MAX_UPLOAD_BYTES} t={t} onPicked={chooseTorrent} />
              </>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setSourcePanel(null)}>{t('home.cancel')}</button>
            </div>
          </div>
        </dialog>
      ) : null}
    </main>
  )
}

/**
 * The room's picture when its source is a shared screen.
 *
 * Everyone joins the WebRTC session as a subscriber. The controller publishes
 * from inside its own click, so the browser still sees a user gesture when the
 * screen picker opens, and attaches its own track locally since a publisher is
 * never subscribed to itself.
 */
function ScreenStage({ roomId, memberId, capability, isController, t }: {
  roomId: string
  memberId: string
  capability: string
  isController: boolean
  t: Translator
}) {
  const tileRef = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<LiveKitRoom | null>(null)
  const [sharing, setSharing] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!memberId || !capability) return
    let disposed = false
    let joined: LiveKitRoom | null = null
    void startScreenShare(roomId, memberId, capability, (element) => {
      tileRef.current?.replaceChildren(element)
    }, { publish: false }).then((connected) => {
      if (disposed) { void connected.disconnect(); return }
      joined = connected
      setLive(connected)
    }).catch(() => setFailed(true))
    return () => {
      disposed = true
      void joined?.disconnect()
    }
  }, [roomId, memberId, capability])

  const toggleShare = async () => {
    if (!live) return
    setFailed(false)
    try {
      const publication = await live.localParticipant.setScreenShareEnabled(!sharing)
      const element = publication?.track?.attach()
      if (element) tileRef.current?.replaceChildren(element)
      setSharing(!sharing)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div className="player-wrap screen-stage">
      <div ref={tileRef} className="screen-surface" />
      <div className="screen-overlay">
        {!sharing ? <p>{isController ? t('room.screenHostHint') : t('room.screenWaiting')}</p> : null}
        {isController ? (
          <button className="primary-button" disabled={!live} onClick={() => { void toggleShare() }}>
            {sharing ? t('room.screenStop') : t('room.screenStart')}
          </button>
        ) : null}
        {failed ? <span className="error-card compact">{t('error.screenshare')}</span> : null}
      </div>
    </div>
  )
}

// Turns the presence log into a short-lived queue. Each entry is retired on
// its own timer, so a burst of arrivals drains one at a time instead of
// stacking up and covering the player.
function usePresenceToasts(presence: PresenceEvent[]): PresenceEvent[] {
  const [toasts, setToasts] = useState<PresenceEvent[]>([])
  const lastSeenRef = useRef(0)

  useEffect(() => {
    const fresh = presence.filter((event) => event.id > lastSeenRef.current)
    if (fresh.length === 0) return
    lastSeenRef.current = fresh[fresh.length - 1].id
    setToasts((current) => [...current, ...fresh])
  }, [presence])

  useEffect(() => {
    if (toasts.length === 0) return
    const timer = window.setTimeout(() => setToasts((current) => current.slice(1)), PRESENCE_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toasts])

  return toasts
}

function PresenceToasts({ events, t }: { events: PresenceEvent[]; t: Translator }) {
  if (events.length === 0) return null
  return (
    <div className="presence-toasts" role="status" aria-live="polite">
      {events.slice(0, MAX_VISIBLE_TOASTS).map((event) => (
        <span key={event.id} className={`presence-toast ${event.kind === 'leave' ? 'is-leave' : ''}`}>
          <strong>{event.nickname}</strong> {t(event.kind === 'join' ? 'presence.joined' : 'presence.left')}
        </span>
      ))}
    </div>
  )
}

function EmptyRoom() {
  const t = useT()
  return <main className="center-state"><div className="state-card raised"><h1>{t('room.expired')}</h1><Link className="primary-button" to="/">{t('room.new')}</Link></div></main>
}
