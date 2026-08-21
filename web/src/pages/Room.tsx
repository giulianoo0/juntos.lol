import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Room as LiveKitRoom } from 'livekit-client'
import { Chat } from '../chat/Chat'
import { StatusPill } from '../components/StatusPill'
import { UploadAvailability } from '../components/UploadAvailability'
import { Check, Crown, Link2, MessageSquare, MonitorUp, Replace, Upload } from 'lucide-react'
import { useT, type Translator } from '../i18n/useT'
import { Player } from '../player/Player'
import { useSync } from '../player/useSync'
import {
  dropScreenStream,
  isScreenShareCancelled,
  requestScreenStream,
  stashScreenStream,
  startScreenShare,
  takeScreenStream,
} from '../screenshare'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import { Dialog, DialogContent } from '../ui/Dialog'
import { useToast } from '../ui/toastContext'
import { playJoinChime } from '../ui/chime'
import type { ChatEntry, Member, PresenceEvent, RoomInfo, RoomWaiting } from '../types'
import { TorrentPicker } from '../components/TorrentPicker'
import type { TorrentSession, TorrentVideoFile } from '../torrent'
import { MAX_UPLOAD_BYTES } from './Home'
import {
  FILE_UNREADABLE,
  changeRoomSource,
  prepareLocalFile,
  subscribeUploadDone,
  subscribeUploadProgress,
  uploadFileToRoom,
  startTorrentTransfer,
  type RoomUploadProgress,
} from '../upload'

// How long the copied tick stands before the button offers the copy again.
const COPIED_MS = 1_800
// How often a room still being prepared re-reads its own progress, as a
// fallback for the live updates rather than a replacement for them.
const PREPARING_POLL_MS = 3_000

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

  // Everything before the room can play is one surface changing what it says,
  // so arriving, being asked for a name and watching the file land read as one
  // continuous wait instead of three screens replacing each other.
  const waiting: GateStep = missing ? 'expired' : !room ? 'connecting' : !nickname ? 'join' : null
  if (waiting !== null) {
    return (
      <RoomGate
        step={waiting}
        onJoin={(value) => { localStorage.setItem('ss.nickname', value); setNickname(value) }}
      />
    )
  }
  return <ConnectedRoom room={room!} nickname={nickname} />
}

/** Every state the room passes through before there is a picture to show. */
type GateStep = 'connecting' | 'join' | 'expired' | 'preparing' | 'failed' | 'error' | null

/**
 * The room's waiting room: one panel that changes what it is asking for or
 * reporting, travelling between the sizes each state needs and dissolving
 * between them, rather than swapping whole screens.
 */
function RoomGate({ step, onJoin, progress, preparation, failure, errorMessage }: {
  step: GateStep
  onJoin?: (nickname: string) => void
  progress?: RoomUploadProgress | null
  preparation?: RoomInfo['preparation']
  failure?: string | null
  errorMessage?: string
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const { shown, morphing } = useMorphingStep(step)
  return (
    <main className="center-state">
      <MorphPanel className="gate-panel raised" sizeKey={shown} morphing={morphing}>
        {shown === 'connecting' ? (
          <div className="gate-centered">
            <span className="stage-spinner" aria-hidden="true" />
            <StatusPill status="connecting" label={t('status.connecting')} />
          </div>
        ) : null}

        {shown === 'join' ? (
          // The room link is the whole invitation: whoever opens it is already
          // in, and the only thing still missing is what to call them.
          <form className="join-card" onSubmit={(event) => {
            event.preventDefault()
            onJoin?.(draft.trim() || guestName())
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
        ) : null}

        {shown === 'preparing' ? (
          <UploadAvailability progress={progress ?? null} preparation={preparation} t={t} />
        ) : null}

        {shown === 'expired' ? (
          <div className="gate-centered">
            <h1>{t('room.expired')}</h1>
            <Link className="primary-button" to="/">{t('room.new')}</Link>
          </div>
        ) : null}

        {shown === 'failed' ? (
          <div className="gate-centered gate-bad">
            <h1>{t('room.uploadFailed')}</h1>
            {failure === FILE_UNREADABLE ? <p>{t('error.fileChanged')}</p> : null}
            <Link className="primary-button" to="/">{t('room.new')}</Link>
          </div>
        ) : null}

        {shown === 'error' ? (
          <div className="gate-centered gate-bad">
            <h1>{t('room.error')}</h1>
            {errorMessage ? <p>{errorMessage}</p> : null}
            <Link className="primary-button" to="/">{t('room.new')}</Link>
          </div>
        ) : null}
      </MorphPanel>
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
  const sync = useSync(room.id, nickname, videoRef)
  const { toast } = useToast()
  const [liveRoom, setLiveRoom] = useState(room)
  const [chatOpen, setChatOpen] = useState(true)
  const [uploadProgress, setUploadProgress] = useState<RoomUploadProgress | null>(null)
  const [uploadFailed, setUploadFailed] = useState<string | null>(null)
  const mediaStatus = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status
  usePresenceNotices(sync.presence, t)
  const [sourcePanel, setSourcePanel] = useState<'menu' | 'torrent' | null>(null)
  // Messages that arrived while the chat was shut. Counting from a mark rather
  // than incrementing a tally keeps it right when history arrives at once.
  const [readMark, setReadMark] = useState(() => sync.messages.length)
  const unread = chatOpen ? 0 : Math.max(0, sync.messages.length - readMark)
  const [sourceError, setSourceError] = useState(false)
  const [copied, setCopied] = useState(false)
  const { shown: copiedShown, morphing: copyMorphing } = useMorphingStep(copied)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isScreenRoom = liveRoom.sourceKind === 'screen'
  // The room is still waiting on something, or it is not. Running the last of
  // those states through the same step machine is what lets the panel dissolve
  // before the picture arrives, instead of the two cutting over each other.
  const gate: GateStep = uploadFailed !== null ? 'failed'
    : mediaStatus === 'processing' || mediaStatus === 'uploading' ? 'preparing'
    : mediaStatus === 'error' ? 'error'
    : null
  const { shown: shownGate } = useMorphingStep(gate)

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
      uploadFileToRoom(room.id, next.uploadEndpoint, next.streamStartBytes, next.mediaGeneration, prepared)
    })
  }

  const chooseTorrent = (file: TorrentVideoFile, session: TorrentSession) => {
    void swapSource(async () => {
      const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', file.name)
      await startTorrentTransfer(room.id, next.uploadEndpoint, next.streamStartBytes, next.mediaGeneration, { file, session })
    })
  }

  const chooseScreen = () => {
    void requestScreenStream().then((stream) => {
      stashScreenStream(room.id, stream)
      return swapSource(async () => {
        try {
          await changeRoomSource(room.id, sync.memberId, sync.capability, 'screen')
        } catch (error) {
          dropScreenStream(room.id)
          throw error
        }
      })
    }).catch((error: unknown) => {
      if (!isScreenShareCancelled(error)) setSourceError(true)
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

  // While a room is being prepared its numbers move on the server, and the
  // only signal that they moved is a WebSocket frame. A connection that drops
  // during a long download would otherwise leave the waiting screen frozen on
  // whatever it last heard, which reads exactly like a transfer that died.
  const preparing = mediaStatus === 'uploading' || mediaStatus === 'processing'
  useEffect(() => {
    if (!preparing) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal })
        .then(async (response) => { if (response.ok) setLiveRoom(await response.json() as RoomInfo) })
        .catch(() => undefined)
    }, PREPARING_POLL_MS)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [preparing, room.id])

  // Media and subtitle updates carry the current media status; each signal
  // means fresh room metadata is available. The refetch in flight is never
  // cancelled by the next signal: during a download the signals arrive every
  // second or so, and on a connection where each round trip is slower than
  // that, cancelling would throw away every response and freeze the room —
  // and its subtitles — at whatever the viewer joined with. Signals that land
  // mid-fetch coalesce into a single trailing refetch instead.
  const refetch = useRef({ running: false, latest: 0, controller: null as AbortController | null })
  useEffect(() => {
    const state = refetch.current
    state.latest = sync.roomVersion
    if (sync.roomVersion === 0 || state.running) return
    state.running = true
    const controller = new AbortController()
    state.controller = controller
    void (async () => {
      try {
        let fetched = -1
        while (fetched !== state.latest) {
          fetched = state.latest
          const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal })
          if (response.ok) setLiveRoom(await response.json() as RoomInfo)
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('room refetch failed', error)
        }
      } finally {
        state.running = false
        state.controller = null
      }
    })()
  }, [sync.roomVersion, room.id])
  useEffect(() => {
    const state = refetch.current
    return () => {
      state.controller?.abort()
      state.running = false
      state.latest = 0
    }
  }, [room.id])

  useEffect(() => {
    if (chatOpen) setReadMark(sync.messages.length)
  }, [chatOpen, sync.messages.length])

  // Show this tab's own background upload progress while it is running.
  useEffect(() => subscribeUploadProgress(room.id, setUploadProgress), [room.id, liveRoom.mediaGeneration])
  useEffect(() => {
    setUploadFailed(null)
    return subscribeUploadDone(room.id, (error) => {
      setUploadProgress(null)
      if (error) setUploadFailed(error)
    })
  }, [room.id, liveRoom.mediaGeneration])

  const copyLink = async () => {
    // The clipboard is refused outright on an insecure origin and can be
    // denied on a secure one. Confirming a copy that did not happen is worse
    // than saying nothing, so the tick is only shown once the write resolves.
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${room.id}`)
    } catch (error) {
      console.error('copy room link failed', error)
      return
    }
    toast(t('room.copiedToast'))
    setCopied(true)
  }
  // The tick stands for a moment and then the button goes back to offering the
  // copy, so a link can be shared twice without wondering whether it took.
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  // Held one beat past the moment the room became playable: the panel spends
  // it dissolving, so the picture arrives into an empty screen rather than
  // over the top of what was still being said.
  if (shownGate !== null) {
    return (
      <RoomGate
        step={gate}
        progress={uploadProgress}
        preparation={liveRoom.preparation}
        failure={uploadFailed}
        errorMessage={liveRoom.errorMessage}
      />
    )
  }

  return (
    <main className="room-shell room-enter">
      <header className="room-header">
        <div className="room-heading"><span className="room-file">{isScreenRoom ? t('room.screenLabel') : liveRoom.fileName}</span></div>
        <div className="header-actions">
          {uploadProgress !== null ? <span className="upload-chip">{t('home.uploading')} {uploadProgress.pct}%</span> : null}
          {uploadFailed !== null ? <span className="upload-chip is-error">{t('room.uploadFailed')}</span> : null}
          <StatusPill status={sync.buffering ? 'buffering' : sync.connected ? 'live' : 'connecting'} label={t(sync.buffering ? 'status.buffering' : sync.connected ? 'status.live' : 'status.connecting')} />
          {sync.isController && !isScreenRoom ? (
            <Button
              className={`sync-toggle ${sync.gatingEnabled ? 'is-on' : ''}`}
              variant="ghost"
              size="small"
              role="switch"
              aria-checked={sync.gatingEnabled}
              onClick={() => sync.send('gating', { enabled: !sync.gatingEnabled })}
            >
              <span className="sync-toggle-box" aria-hidden="true">
                {sync.gatingEnabled ? <Check size={11} strokeWidth={3.5} /> : null}
              </span>
              {t('room.gating')}
            </Button>
          ) : null}
          {sync.isController ? (
            <IconButton
              icon={<Replace size={16} />}
              label={t('room.changeSource')}
              onClick={() => { setSourceError(false); setSourcePanel('menu') }}
            />
          ) : null}
          <IconButton
            icon={
              // The glyph is what confirms the copy; the button keeps naming
              // itself, so a lone tick never has to be worked out.
              <span className="morph-fade" data-morphing={copyMorphing}>
                {copiedShown ? <Check size={16} /> : <Link2 size={16} />}
              </span>
            }
            label={t('room.copy')}
            className={copiedShown ? 'is-confirmed' : ''}
            onClick={copyLink}
          />
          <IconButton
            icon={<>
              <MessageSquare size={16} />
              {unread > 0 ? <span className="chat-badge">{unread > 9 ? '9+' : unread}</span> : null}
            </>}
            label={t('chat.title')}
            className={`chat-toggle ${chatOpen ? 'is-on' : ''}`}
            aria-pressed={chatOpen}
            onClick={() => setChatOpen((open) => !open)}
          />
        </div>
      </header>
      <div className={`room-layout ${chatOpen ? 'chat-open' : ''}`}>
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
            <Player
              room={liveRoom}
              isController={sync.isController}
              videoRef={videoRef}
              send={sync.send}
              t={t}
              syncState={sync.state}
              serverOffsetMs={sync.serverOffsetMs}
            />
          )}
          {sync.waiting !== null && !isScreenRoom ? (
            <WaitingPanel
              waiting={sync.waiting}
              members={sync.members}
              isController={sync.isController}
              selfId={sync.memberId}
              onIgnore={(memberId) => sync.send('ignore', { targetId: memberId })}
              t={t}
            />
          ) : null}
          <div className="presence-row">
            {sync.members.map((member) => (
              <span key={member.id} className={`member-chip ${member.id === sync.controllerId ? 'is-controller' : ''}`}>
{member.nickname}{member.id === sync.controllerId ? <Crown size={12} aria-hidden="true" /> : null}
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
      <Dialog open={sourcePanel !== null} onOpenChange={(open) => { if (!open) setSourcePanel(null) }}>
        {sourcePanel !== null ? (
          <DialogContent
            className="torrent-dialog"
            closeLabel={t('home.closeDialog')}
            hideTitle={sourcePanel === 'torrent'}
            title={sourcePanel === 'menu' ? t('room.changeSourceTitle') : t('home.torrentTitle')}
            description={sourcePanel === 'menu' ? t('room.changeSourceGuide') : undefined}
          >
            {sourcePanel === 'menu' ? (
              <div className="source-options">
                <Button onClick={() => { setSourcePanel(null); fileInputRef.current?.click() }}>
                  <Upload size={17} aria-hidden="true" />{t('room.sourceFile')}
                </Button>
                <Button onClick={() => setSourcePanel('torrent')}>
                  <span className="magnet-glyph" aria-hidden="true">µ</span>{t('room.sourceTorrent')}
                </Button>
                <Button onClick={chooseScreen}>
                  <MonitorUp size={17} aria-hidden="true" />{t('room.sourceScreen')}
                </Button>
              </div>
            ) : (
              <TorrentPicker
                maxFileBytes={MAX_UPLOAD_BYTES}
                t={t}
                onExit={() => setSourcePanel('menu')}
                onPicked={chooseTorrent}
              />
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </main>
  )
}

// While the server holds a gated start, everyone sees the same picture of who
// is ready and who is still buffering, instead of a play that quietly ignores
// the people it left behind.
function WaitingPanel({ waiting, members, isController, selfId, onIgnore, t }: {
  waiting: RoomWaiting
  members: Member[]
  isController: boolean
  selfId: string
  onIgnore: (memberId: string) => void
  t: Translator
}) {
  const names = new Map(members.map((member) => [member.id, member.nickname]))
  return (
    <div className="waiting-panel raised" role="status">
      <strong>{t('room.waitingStart')}</strong>
      {waiting.readiness.map((member) => (
        <span key={member.memberId} className={`waiting-row ${member.ready ? 'is-ready' : ''} ${member.ignored ? 'is-ignored' : ''}`}>
          {names.get(member.memberId) ?? member.memberId}
          <span className="waiting-state">
            {member.ignored
              ? t('room.waitingIgnored')
              : member.ready ? t('room.waitingReady') : t('room.waitingBuffering')}
            {/* Only offered for whoever is actually holding the room up, and
                never for the controller themselves: a room that stopped
                waiting for the person driving it would wait for nobody. */}
            {isController && !member.ignored && !member.ready && member.memberId !== selfId ? (
              <Button variant="ghost" size="small" onClick={() => onIgnore(member.memberId)}>
                {t('room.ignore')}
              </Button>
            ) : null}
          </span>
        </span>
      ))}
    </div>
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
  const surfaceRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<LiveKitRoom | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [failed, setFailed] = useState(false)

  // Keeps the last thing everyone saw as a blurred still. Going straight to an
  // empty surface reads as a fault; a frozen frame reads as an ending.
  const freezeLastFrame = useCallback(() => {
    const surface = surfaceRef.current
    const video = surface?.querySelector('video')
    if (!surface || !video?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.className = 'screen-frozen'
    surface.replaceChildren(canvas)
  }, [])

  const showLocally = useCallback((stream: MediaStream) => {
    const video = document.createElement('video')
    video.srcObject = stream
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    surfaceRef.current?.replaceChildren(video)
  }, [])

  const endSharing = useCallback(() => {
    freezeLastFrame()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setSharing(false)
  }, [freezeLastFrame])

  // Watches for the browser's own stop-sharing control, which ends the track
  // without ever going through this component.
  const adopt = useCallback((stream: MediaStream) => {
    streamRef.current = stream
    showLocally(stream)
    setSharing(true)
    stream.getVideoTracks()[0]?.addEventListener('ended', endSharing, { once: true })
  }, [endSharing, showLocally])

  useEffect(() => {
    if (!memberId || !capability) return
    let disposed = false
    let joined: LiveKitRoom | null = null
    // A screen granted before this room existed is published on arrival, so
    // the picker is never shown twice for the same share.
    const granted = takeScreenStream(roomId)
    void startScreenShare(roomId, memberId, capability, (element) => {
      surfaceRef.current?.replaceChildren(element)
    }, { publish: false, stream: granted }).then((connected) => {
      if (disposed) {
        void connected.disconnect()
        granted?.getTracks().forEach((track) => track.stop())
        return
      }
      joined = connected
      liveRef.current = connected
      setReady(true)
      if (granted) adopt(granted)
    }).catch(() => setFailed(true))
    return () => {
      disposed = true
      liveRef.current = null
      void joined?.disconnect()
    }
  }, [roomId, memberId, capability, adopt])

  const startSharing = () => {
    setFailed(false)
    // Straight out of the click: no await may come first or the picker is
    // refused for want of user activation.
    void requestScreenStream().then(async (stream) => {
      const live = liveRef.current
      if (!live) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const { Track } = await import('livekit-client')
      const [track] = stream.getVideoTracks()
      if (track) await live.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare })
      adopt(stream)
    }).catch((error: unknown) => {
      if (!isScreenShareCancelled(error)) setFailed(true)
    })
  }

  const stopSharing = () => {
    const live = liveRef.current
    void live?.localParticipant.setScreenShareEnabled(false).catch(() => undefined)
    endSharing()
  }

  return (
    <div className="player-wrap screen-stage">
      <div ref={surfaceRef} className="screen-surface" />
      <div className="screen-overlay">
        {!sharing ? <p>{isController ? t('room.screenHostHint') : t('room.screenWaiting')}</p> : null}
        {isController ? (
          <button className="primary-button" disabled={!ready} onClick={sharing ? stopSharing : startSharing}>
            {sharing ? t('room.screenStop') : t('room.screenStart')}
          </button>
        ) : null}
        {failed ? <span className="error-card compact">{t('error.screenshare')}</span> : null}
      </div>
    </div>
  )
}

/**
 * Announces arrivals and departures through the same notifications everything
 * else uses, and gives an arrival a sound.
 *
 * A room is watched, not read: whoever just joined is looking at the picture,
 * not at a corner of the screen, so the arrival has to be audible as well as
 * visible. Departures stay silent — nobody needs calling back to the screen
 * because somebody left.
 */
function usePresenceNotices(presence: PresenceEvent[], t: Translator): void {
  const { toast } = useToast()
  const lastSeenRef = useRef(0)

  useEffect(() => {
    const fresh = presence.filter((event) => event.id > lastSeenRef.current)
    if (fresh.length === 0) return
    lastSeenRef.current = fresh[fresh.length - 1].id
    for (const event of fresh) {
      toast(
        <span className={event.kind === 'leave' ? 'is-leave' : ''}>
          <strong>{event.nickname}</strong> {t(event.kind === 'join' ? 'presence.joined' : 'presence.left')}
        </span>,
      )
      if (event.kind === 'join') playJoinChime()
    }
  }, [presence, t, toast])
}

