import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMessageChime } from '../chat/useMessageChime'
import { ChaptersPanel } from '../player/ChaptersPanel'
import { CopyErrorReport } from '../components/CopyErrorReport'
import { StillThere } from '../components/StillThere'
import { caretToEndOnFocus } from '../ui/caret'
import { UploadAvailability, type OpeningWait } from '../components/UploadAvailability'
import { X } from 'lucide-react'
import { useT, type Translator } from '../i18n/useT'
import { Player, regionHolds } from '../player/Player'
import { useSync } from '../player/useSync'
import { displayCaptureAvailable, screenShareSupported } from '../screenshare'
import { ScreenStage, screenStartedNotice, useScreenShareNotices } from '../screen/ScreenStage'
import { useScreenShare } from '../screen/useScreenShare'
import { JlocalPicker } from '../screen/JlocalPicker'
import { isJLocalCaptureAvailable } from '../jlocal/capabilities'
import { canDriveMedia, canOpenStage, currentSpotlight, hasMedia, stagesOf } from '../room/stages'
import { useStageHosts } from '../room/stageHosts'
import { EntryScreen, EntrySkeleton, RoomView, WaitingRoom } from '../room/ui'
import { useRoomStrings } from '../room/ui/strings'
import type { ChatMessage as ViewChatMessage, EntryViewModel, Person, RoomViewModel, ShareSource, Stage as ViewStage } from '../room/model'
import { claimOwnerFromHash, fetchRoomPreview, requestJoinTicket, setRoomAccess, type JoinMode, type RoomPreview } from '../join'
import { useLocalMedia } from '../call/useLocalMedia'
import { localLevel } from '../call/media'
import { voiceLevel } from '../call/speaking'
import { discordLoginUrl, updateMe, useMe } from '../account'
import { serializeAvatar } from '../mascot'
import { avatarOf, loadPickedAvatar, savePickedAvatar } from '../room/avatar'
import { useCall, type CallMessage } from '../call/useCall'
import { CallProvider, CallVideo } from '../call/CallVideo'
import { Button } from '../ui/Button'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import { Dialog, DialogContent } from '../ui/Dialog'
import { useToast } from '../ui/toastContext'
import { playJoinChime } from '../ui/chime'
import type { ChatEntry, Member, PresenceEvent, RoomInfo, RoomWaiting, TitleRequest } from '../types'
import type { OverlayFocus } from '../catalog/CatalogOverlay'
const CatalogOverlay = lazy(() => import('../catalog/CatalogOverlay').then((module) => ({ default: module.CatalogOverlay })))
import { openCatalogStream } from '../catalog/openStream'
import { WorkerProbes } from '../components/WorkerProbes'
import type { TitlePick } from '../catalog/MetaDetails'
import { NextEpisodeCard } from '../catalog/NextEpisode'
import { nowPlayingFromPick, nowPlayingKey, useNextEpisode, type NowPlaying } from '../catalog/useNextEpisode'
import { TorrentPicker } from '../components/TorrentPicker'
import { DrivePicker, drivePlaybackUrls } from '../components/DrivePicker'
import { YoutubePicker } from '../components/YoutubePicker'
import { LiveStage } from '../components/LiveStage'
import { startYoutubeLive, stopLive } from '../live'
import { YoutubeError, isYoutubeError, openYoutube, youtubeErrorKey, youtubeErrorRetryable, type YoutubeSession } from '../youtube'
import { PipelineChip } from '../components/PipelineChip'
import { openTorrent, type TorrentSession, type TorrentVideoFile, type WorkerProbe } from '../torrent'
import { isTorrentError, torrentErrorKey, torrentErrorRetryable } from '../torrentErrors'
import { MAX_UPLOAD_BYTES } from '../limits'
import {
  FILE_UNREADABLE,
  SOURCE_UNREACHABLE,
  UNSUPPORTED_MEDIA,
  WORKER_UNREACHABLE,
  REMUX_UNAVAILABLE,
  assertReadable,
  changeRoomSource,
  lastUploadFailureDetail,
  subscribeUploadDone,
  subscribeUploadProgress,
  startFileUpload,
  isRemoteProduction,
  startTorrentUpload,
  startUrlUpload,
  startYoutubeUpload,
  youtubeFileName,
  type RoomUploadProgress,
  remuxHandleFor,
  torrentStatsFor,
  uploadActive,
  resumableSourceFor,
  clearResumableSource,
  ownerTokenFor,
  sourceOriginFor,
} from '../upload'
import { expectedPositionMs } from '../player/position'
import { isReaction, splitReactions } from '../room/reactions'
import type { TorrentStats } from '../torrent'

const PREPARING_POLL_MS = 3_000
// How long a pipeline may go quiet before the room counts as unproduced: long
// enough to outlast a cold seek, well short of the server's claim sweep.
const PRODUCER_ALIVE_MS = 90_000

/** A room, mounted above the routes: full screen on its own route, and
    once you are in the call, waiting in the corner while you browse. */
export function RoomPage({ id, onInCall }: { id: string; onInCall: (inCall: boolean) => void }) {
  const t = useT()
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [preview, setPreview] = useState<RoomPreview | null>(null)
  const [missing, setMissing] = useState(false)
  const [entered, setEntered] = useState<{ nickname: string; mic: boolean; cam: boolean } | null>(null)
  useEffect(() => {
    onInCall(entered !== null)
    return () => onInCall(false)
  }, [entered, onInCall])
  const [entryError, setEntryError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const owner = useMemo(() => claimOwnerFromHash(id) || ownerTokenFor(id) !== '', [id])
  const local = useLocalMedia()
  const { me } = useMe()
  const [picked, setPicked] = useState(loadPickedAvatar)
  // The microphone's level at the door, for the mascot to talk with.
  const meterRef = useRef<{ level(): number; close(): void } | null>(null)
  useEffect(() => {
    if (!local.micTrack) return
    const meter = localLevel(local.micTrack)
    meterRef.current = meter
    return () => {
      meter.close()
      if (meterRef.current === meter) meterRef.current = null
    }
  }, [local.micTrack])
  const micLevel = useCallback(() => voiceLevel(meterRef.current?.level() ?? 0), [])

  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/rooms/${encodeURIComponent(id)}`, { signal: controller.signal }).then(async (response) => {
      if (response.status === 404) { setMissing(true); return }
      if (response.status === 403) return
      if (!response.ok) throw new Error('room request failed')
      setRoom(await response.json() as RoomInfo)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setMissing(true)
    })
    void fetchRoomPreview(id).then((found) => {
      if (found) setPreview(found)
      else setMissing(true)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [id])

  if (missing) return <RoomGate step="expired" />
  if (!preview) return <EntrySkeleton />

  const joinMode: JoinMode = owner ? 'open' : preview.joinMode
  if (!entered) {
    const storedNickname = (() => { try { return localStorage.getItem('ss.nickname') || '' } catch { return '' } })()
    const entryAvatar = me?.avatar || picked || serializeAvatar(avatarOf(undefined, storedNickname || id))
    const vm: EntryViewModel = {
      name: preview.name || room?.fileName || '',
      joinMode,
      present: preview.nicknames,
      presentCount: preview.memberCount,
      nickname: storedNickname,
      mic: local.mic,
      cam: local.cam,
      level: micLevel,
      avatar: entryAvatar,
      setAvatar: (next) => {
        savePickedAvatar(next)
        setPicked(next)
        if (me) void updateMe({ avatar: next }).catch(() => undefined)
      },
      account: me ? { id: me.id } : null,
      loginUrl: discordLoginUrl(`/room/${id}`),
      busy,
      error: entryError,
      setMic: (on) => { void local.setMic(on) },
      setCam: (on) => { void local.setCam(on) },
      renderPreview: () => <PreviewVideo stream={local.previewStream} />,
      join: ({ nickname: typed, password }) => {
        setEntryError(undefined)
        const nickname = typed || guestName()
        const go = () => {
          try { localStorage.setItem('ss.nickname', nickname) } catch {}
          // The face shown at the door is the one the room sees.
          if (!picked) savePickedAvatar(entryAvatar)
          // An account without a face keeps the one it walked in with.
          if (me && !me.avatar) void updateMe({ avatar: entryAvatar }).catch(() => undefined)
          const choice = { nickname, mic: local.mic, cam: local.cam }
          void local.setMic(false)
          void local.setCam(false)
          setEntered(choice)
        }
        if (joinMode !== 'password') { go(); return }
        setBusy(true)
        void requestJoinTicket(id, password).then(go).catch((error: unknown) => {
          const code = error instanceof Error ? error.message : 'failed'
          setEntryError(t(code === 'bad_password' ? 'room.badPassword' : code === 'too_many_attempts' ? 'room.tooManyAttempts' : 'room.error'))
        }).finally(() => setBusy(false))
      },
    }
    return <EntryScreen vm={vm} />
  }
  return (
    <ConnectedRoom
      roomId={id}
      initialRoom={room}
      roomName={preview.name ?? ''}
      nickname={entered.nickname}
      initialMedia={{ mic: entered.mic, cam: entered.cam }}
      onPasswordAgain={(bad) => {
        setEntryError(bad ? t('room.badPassword') : undefined)
        setPreview((current) => current ? { ...current, joinMode: 'password' } : current)
        setEntered(null)
      }}
    />
  )
}

function PreviewVideo({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
}

/** A room behind a door answers its members only; they name themselves. */
function fetchRoomInfo(roomId: string, memberId: string, capability: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
    signal,
    headers: memberId ? { 'X-Member-Id': memberId, 'X-Capability': capability } : undefined,
  })
}

function emptyRoom(id: string): RoomInfo {
  return {
    id, fileName: '', status: 'empty', mediaGeneration: 0, controllerId: '', audioTracks: null,
    subtitleTracks: null, bitmapSubsSkipped: 0, memberCount: 0, expiresAt: '',
  }
}

type GateStep = 'join' | 'expired' | 'denied' | 'preparing' | 'buffering' | 'failed' | 'error' | null

/** One panel that changes what it asks for, rather than swapping screens. */
function RoomGate({ step, room, onJoin, progress, preparation, swarm, wait, overlay = false, inline = false, leaving = false, failure, errorMessage }: {
  step: GateStep
  room?: RoomInfo
  onJoin?: (nickname: string) => void
  progress?: RoomUploadProgress | null
  preparation?: RoomInfo['preparation']
  swarm?: TorrentStats | null
  wait?: OpeningWait | null
  /** Laid over the room rather than in place of it. */
  overlay?: boolean
  /** In the media's stage, beside the others, rather than in place of the room. */
  inline?: boolean
  leaving?: boolean
  failure?: string | null
  errorMessage?: string
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const { shown, morphing } = useMorphingStep(step)
  const Shell = inline ? 'div' : 'main'
  return (
    <Shell
      className={inline ? 'player-wrap' : `center-state${overlay ? ' gate-overlay' : ''}${leaving ? ' is-leaving' : ''}`}
      style={inline ? { display: 'grid', placeItems: 'center', padding: 16, overflow: 'auto' } : undefined}
    >
      <MorphPanel className="gate-panel raised" sizeKey={shown} morphing={morphing}>
        {shown === 'join' ? (
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
              onFocus={caretToEndOnFocus}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="primary-button">{t('room.join')}</button>
          </form>
        ) : null}

        {shown === 'preparing' || shown === 'buffering' ? (
          <UploadAvailability progress={progress ?? null} preparation={preparation} swarm={swarm} wait={shown === 'buffering' ? wait ?? { secondsLeft: null, cold: false } : null} t={t} />
        ) : null}

        {shown === 'denied' ? (
          <div className="gate-centered">
            <h1>{t('room.denied')}</h1>
            <Link className="primary-button" to="/">{t('room.new')}</Link>
          </div>
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
            {failure === UNSUPPORTED_MEDIA ? <p>{t('error.unsupportedMedia')}</p> : null}
            {failure === SOURCE_UNREACHABLE ? <p>{t('error.sourceUnreachable')}</p> : null}
            {failure === WORKER_UNREACHABLE ? <p>{t('error.workerUnreachable')}</p> : null}
            {failure === REMUX_UNAVAILABLE ? <p>{t('error.remuxUnavailable')}</p> : null}
            <Link className="primary-button" to="/">{t('room.new')}</Link>
            {room ? <CopyErrorReport room={room} failure={failure ?? null} detail={lastUploadFailureDetail()} t={t} /> : null}
          </div>
        ) : null}

        {shown === 'error' ? (
          <div className="gate-centered gate-bad">
            <h1>{t('room.error')}</h1>
            {errorMessage ? <p>{errorMessage}</p> : null}
            <Link className="primary-button" to="/">{t('room.new')}</Link>
            {room ? <CopyErrorReport room={room} failure={errorMessage ?? 'server'} detail={lastUploadFailureDetail()} t={t} /> : null}
          </div>
        ) : null}
      </MorphPanel>
    </Shell>
  )
}

// Mirrors the guest name the server hands out, so a blank field is valid.
function guestName(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const random = crypto.getRandomValues(new Uint8Array(6))
  return `Guest-${Array.from(random, (value) => alphabet[value % alphabet.length]).join('')}`
}

function ConnectedRoom({ roomId, initialRoom, roomName, nickname, initialMedia, onPasswordAgain }: {
  roomId: string
  initialRoom: RoomInfo | null
  roomName: string
  nickname: string
  initialMedia: { mic: boolean; cam: boolean }
  onPasswordAgain: (bad: boolean) => void
}) {
  const room = useMemo(() => initialRoom ?? emptyRoom(roomId), [initialRoom, roomId])
  const t = useT()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaOffsetMsRef = useRef(0)
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null)
  const coldWaitRef = useRef(false)
  const coldForRef = useRef<((ms: number) => boolean) | null>(null)
  const remoteSteerAtRef = useRef(0)
  const sync = useSync(room.id, nickname, videoRef, mediaOffsetMsRef, coldWaitRef, remoteSteerAtRef, coldForRef)
  const { leave } = sync
  const leaveIdle = useCallback(() => {
    videoRef.current?.pause()
    leave()
  }, [leave])
  const { toast } = useToast()
  const [liveRoom, setLiveRoom] = useState(room)
  const liveRoomRef = useRef(liveRoom)
  liveRoomRef.current = liveRoom
  useEffect(() => {
    if (!sync.errorSeq) return
    if (sync.lastError === 'not_controller') toast(t('room.notController'))
    else if (sync.lastError === 'rate_limited') toast(t('room.rateLimited'))
  }, [sync.errorSeq, sync.lastError, t, toast])
  if (!liveRoom.mediaRegions || liveRoom.mediaRegions.length === 0) {
    mediaOffsetMsRef.current = liveRoom.mediaOffsetMs ?? 0
  }
  const [localSwarm, setLocalSwarm] = useState<TorrentStats | null>(null)
  useEffect(() => {
    const read = () => setLocalSwarm(torrentStatsFor(room.id))
    read()
    const timer = window.setInterval(read, 1_000)
    return () => window.clearInterval(timer)
  }, [room.id])
  const reported = liveRoom.preparation?.swarm
  const swarmStats: TorrentStats | null = useMemo(() => localSwarm ?? (reported ? {
    peers: reported.peers,
    downloadSpeed: reported.downSpeed,
    downloaded: reported.haveBytes,
    diskBytes: reported.diskBytes,
    progress: reported.selectedBytes > 0 ? Math.min(reported.haveBytes / reported.selectedBytes, 1) : 0,
  } : null), [localSwarm, reported])
  const resumeWanted = sync.state ? expectedPositionMs(sync.state, Date.now() + sync.serverOffsetMs) : null
  const liveRegions = liveRoom.mediaRegions ?? []
  const producing = liveRoom.producerHeartbeatMs !== undefined
    && (Date.now() + sync.serverOffsetMs) - liveRoom.producerHeartbeatMs < PRODUCER_ALIVE_MS
  const needsPreparo = !producing
    && (liveRoom.status !== 'ready'
      || (resumeWanted !== null && liveRegions.length > 0
        && resumeWanted < (liveRoom.durationMs || Number.POSITIVE_INFINITY)
        && !liveRegions.some((region) => regionHolds(region, resumeWanted))))
  const resumeTried = useRef(false)
  useEffect(() => {
    if (resumeTried.current || !sync.memberId || !sync.capability) return
    if (!needsPreparo) return
    // The fleet's first heartbeat lands seconds after the handoff; the tab that
    // made it must not read that silence as a preparo to resume.
    if (uploadActive(room.id) || remuxHandleFor(room.id) || isRemoteProduction(room.id)) return
    const source = resumableSourceFor(room.id)
    if (!source) { resumeTried.current = true; return }
    resumeTried.current = true
    toast(t('room.resuming'))
    void (async () => {
      try {
        if (source.kind === 'url') {
          const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', source.fileName)
          startUrlUpload(room.id, next.mediaGeneration, source.url ?? '', source.fileName, source.size ?? 0)
          return
        }
        if (source.kind === 'live') {
          if (liveRoomRef.current.live) return
          await startYoutubeLive(room.id, { url: source.url ?? '', title: source.fileName }, { memberId: sync.memberId, capability: sync.capability })
          return
        }
        if (source.kind === 'youtube') {
          const session = await openYoutube(source.url ?? '')
          try {
            const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'youtube', youtubeFileName(session))
            startYoutubeUpload(room.id, next.mediaGeneration, session, { memberId: sync.memberId, capability: sync.capability })
          } catch (error) {
            session.destroy()
            throw error
          }
          return
        }
        const session = await openTorrent(source.magnet ?? '')
        const file = session.files.find((candidate) => candidate.path === source.filePath) ?? session.files[0]
        if (!file) {
          session.destroy()
          throw new Error('resumable file missing from torrent')
        }
        await session.select(file.path)
        try {
          const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', file.name)
          startTorrentUpload(room.id, next.mediaGeneration, { file, session }, undefined, { memberId: sync.memberId, capability: sync.capability })
        } catch (error) {
          session.destroy()
          throw error
        }
      } catch (error) {
        console.error('resume preparation failed', error)
        toast(t('room.resumeFailed'))
        if (!torrentErrorRetryable(error) || !youtubeErrorRetryable(error)) clearResumableSource(room.id)
      }
    })()
  }, [needsPreparo, room.id, sync.memberId, sync.capability, t, toast])
  const [sidePanel, setSidePanel] = useState<'chapters' | null>(null)
  const [uploadProgress, setUploadProgress] = useState<RoomUploadProgress | null>(null)
  const [uploadFailed, setUploadFailed] = useState<string | null>(null)
  const mediaStatus = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status
  usePresenceNotices(sync.presence, t)
  // A reaction floats over a tile; it does not ring like a message.
  const chimeMessages = useMemo(() => sync.messages.filter((message) => !isReaction(message.text)), [sync.messages])
  useMessageChime(chimeMessages, sync.connected, nickname)
  // The torrent the room is playing now, when this browser is the one that
  // opened it: the picker lists it again as a playlist instead of asking.
  const playlist = useMemo(() => {
    if (liveRoom.sourceOrigin !== 'torrent') return null
    const source = resumableSourceFor(room.id)
    if (!source || source.kind !== 'torrent' || !source.magnet || source.fileName !== liveRoom.fileName) return null
    return { magnet: source.magnet, filePath: source.filePath }
  }, [liveRoom.sourceOrigin, liveRoom.fileName, room.id])
  const [sourceError, setSourceError] = useState<string>('')
  const [swapProbes, setSwapProbes] = useState<WorkerProbe[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The media, the live and the screens play side by side; the socket knows
  // who the host is before a refetch does.
  const stageRoom = useMemo(() => ({ ...liveRoom, controllerId: sync.controllerId || liveRoom.controllerId }), [liveRoom, sync.controllerId])
  const roomHasMedia = hasMedia(liveRoom)
  const canDrive = canDriveMedia(stageRoom, sync.memberId)
  const mayOpenMedia = canOpenStage(stageRoom, sync.stages, sync.memberId, 'media')
  const mayOpenLive = canOpenStage(stageRoom, sync.stages, sync.memberId, 'live')
  const mayShareScreen = canOpenStage(stageRoom, sync.stages, sync.memberId, 'screen')
  const screens = liveRoom.screens ?? []
  const { stageUsed } = sync
  useEffect(() => {
    const answer = sync.stages.answer
    if (!answer) return
    toast(t(answer.allow ? 'stage.granted' : 'stage.denied'))
  }, [sync.stages.answer, t, toast])
  useEffect(() => {
    if (sync.stages.closed) toast(t('stage.closed'))
  }, [sync.stages.closed, t, toast])
  // Starting the screen spends the grant on the server; a screen of ours in
  // the list is what keeps us publishing from then on.
  const sharingOwnScreen = screens.some((screen) => screen.memberId === sync.memberId)
  useEffect(() => {
    if (sharingOwnScreen) stageUsed('screen')
  }, [sharingOwnScreen, stageUsed])
  // A live of ours the companion app produces stops with the stage.
  useEffect(() => {
    if (!liveRoom.live) stopLive(room.id)
  }, [liveRoom.live, room.id])
  const selfNickname = sync.members.find((member) => member.id === sync.memberId)?.nickname ?? ''
  const [catalogOpen, setCatalogOpen] = useState(false)
  useEffect(() => {
    if (!sync.memberId || !sync.connected) return
    const origin = sourceOriginFor(room.id)
    if (!origin || !(uploadActive(room.id) || remuxHandleFor(room.id))) return
    sync.send('source', { origin })
  }, [room.id, sync.memberId, sync.connected, sync.send, liveRoom.mediaGeneration])
  const [catalogFocus, setCatalogFocus] = useState<OverlayFocus | null>(null)
  const [dismissedRequests, setDismissedRequests] = useState<number[]>([])
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(nowPlayingKey(room.id)) ?? 'null') as NowPlaying | null
    } catch {
      return null
    }
  })
  const gate: GateStep = uploadFailed !== null ? 'failed'
    : mediaStatus === 'processing' || mediaStatus === 'uploading' ? 'preparing'
    : mediaStatus === 'error' ? 'error'
    : null
  const { shown: shownGate } = useMorphingStep(gate)
  const [opening, setOpening] = useState(true)
  const [openingWait, setOpeningWait] = useState<OpeningWait | null>(null)
  useEffect(() => {
    if (gate === 'preparing') { setOpening(true); setOpeningWait(null) }
  }, [gate])
  const onWait = useCallback((wait: OpeningWait) => {
    setOpeningWait(wait)
    if (wait.secondsLeft === null && !wait.cold) setOpening(false)
  }, [])
  const openingGate: GateStep = opening && roomHasMedia && mediaStatus === 'ready' ? 'buffering' : null
  const { shown: shownOpening } = useMorphingStep(openingGate)

  // Opening media spends a guest's grant; the host and the media's owner have none to spend.
  const openMedia = async (kind: 'upload' | 'youtube', fileName: string) => {
    const next = await changeRoomSource(room.id, sync.memberId, sync.capability, kind, fileName)
    stageUsed('media')
    return next
  }

  const swapSource = async (run: () => Promise<void>) => {
    setSourceError('')
    setSwapProbes([])
    try {
      await run()
    } catch (error) {
      console.error('change source failed', error)
      setSourceError(isTorrentError(error) ? torrentErrorKey(error) : isYoutubeError(error) ? youtubeErrorKey(error) : 'room.changeFailed')
    }
  }

  const chooseFile = (file?: File) => {
    if (!file) return
    void swapSource(async () => {
      await assertReadable(file)
      const next = await openMedia('upload', file.name)
      startFileUpload(room.id, next.mediaGeneration, file)
    })
  }

  const chooseDrive = (file: TorrentVideoFile, session: TorrentSession) => {
    void swapSource(async () => {
      try {
        const playback = await drivePlaybackUrls(file, session)
        const next = await openMedia('upload', file.name)
        startUrlUpload(room.id, next.mediaGeneration, playback.url, file.name, file.size, playback.sideFiles)
      } catch (error) {
        session.destroy()
        throw error
      }
    })
  }

  const chooseTorrent = (file: TorrentVideoFile, session: TorrentSession) => {
    void swapSource(async () => {
      let next
      try {
        next = await openMedia('upload', file.name)
      } catch (error) {
        session.destroy()
        throw error
      }
      startTorrentUpload(room.id, next.mediaGeneration, { file, session }, undefined, { memberId: sync.memberId, capability: sync.capability })
    })
  }

  const chooseYoutube = (session: YoutubeSession) => {
    void swapSource(async () => {
      if (session.summary.live) {
        try {
          await startYoutubeLive(room.id, { url: session.url, title: youtubeFileName(session), thumbnail: session.summary.thumbnail }, { memberId: sync.memberId, capability: sync.capability })
          stageUsed('live')
        } finally {
          session.destroy()
        }
        return
      }
      let next
      try {
        next = await openMedia('youtube', youtubeFileName(session))
      } catch (error) {
        session.destroy()
        throw error
      }
      startYoutubeUpload(room.id, next.mediaGeneration, session, { memberId: sync.memberId, capability: sync.capability })
    })
  }

  const chooseCatalogStream = (pick: TitlePick) => {
    setCatalogOpen(false)
    setCatalogFocus(null)
    const playing = nowPlayingFromPick(pick)
    setNowPlaying(playing)
    try {
      if (playing) localStorage.setItem(nowPlayingKey(room.id), JSON.stringify(playing))
      else localStorage.removeItem(nowPlayingKey(room.id))
    } catch {}
    void swapSource(async () => {
      if (pick.stream.location.kind === 'url') {
        const { url } = pick.stream.location
        const next = await openMedia('upload', pick.displayName)
        startUrlUpload(room.id, next.mediaGeneration, url, `${pick.displayName}.mkv`, 0)
        return
      }
      const opened = await openCatalogStream(pick.stream, pick.target, undefined, { onProbe: setSwapProbes })
      try {
        const next = await openMedia('upload', pick.displayName)
        startTorrentUpload(room.id, next.mediaGeneration, opened, undefined, { memberId: sync.memberId, capability: sync.capability })
      } catch (error) {
        opened.session.destroy()
        throw error
      }
    })
  }

  const chatEntries = useMemo((): ChatEntry[] => [
    ...sync.messages,
    ...sync.presence.map((event) => ({
      author: event.nickname,
      text: t(event.kind === 'join' ? 'presence.joined' : 'presence.left'),
      at: event.at,
      system: true,
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)), [sync.messages, sync.presence, t])

  const preparing = mediaStatus === 'uploading' || mediaStatus === 'processing'
  useEffect(() => {
    if (!preparing || sync.connected) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void fetchRoomInfo(room.id, sync.memberId, sync.capability, controller.signal)
        .then(async (response) => { if (response.ok) setLiveRoom(await response.json() as RoomInfo) })
        .catch(() => undefined)
    }, PREPARING_POLL_MS)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [preparing, sync.connected, room.id, sync.memberId, sync.capability])

  const refetch = useRef({ running: false, latest: 0, controller: null as AbortController | null })
  useEffect(() => {
    remuxHandleFor(room.id)?.follow(expectedPositionMs(sync.state, Date.now() + sync.serverOffsetMs))
  }, [room.id, sync.state, sync.serverOffsetMs])

  const { mediaPatch, refreshRoom } = sync
  useEffect(() => {
    if (!mediaPatch) return
    setLiveRoom((current) => {
      if (mediaPatch.mediaGeneration !== current.mediaGeneration || mediaPatch.mediaVersion < (current.mediaVersion ?? 0)) {
        refreshRoom()
        return current
      }
      return {
        ...current,
        mediaVersion: mediaPatch.mediaVersion,
        mediaOffsetMs: mediaPatch.mediaOffsetMs,
        mediaRegions: mediaPatch.mediaRegions ?? undefined,
      }
    })
  }, [mediaPatch, refreshRoom])

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
          const response = await fetchRoomInfo(room.id, sync.memberId, sync.capability, controller.signal)
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
  }, [sync.roomVersion, room.id, sync.memberId, sync.capability])
  useEffect(() => {
    const state = refetch.current
    return () => {
      state.controller?.abort()
      state.running = false
      state.latest = 0
    }
  }, [room.id])

  useEffect(() => subscribeUploadProgress(room.id, setUploadProgress), [room.id, liveRoom.mediaGeneration])
  useEffect(() => {
    setUploadFailed(null)
    return subscribeUploadDone(room.id, (error) => {
      setUploadProgress(null)
      if (error) setUploadFailed(error)
    })
  }, [room.id, liveRoom.mediaGeneration])

  const nextEpisode = useNextEpisode(
    nowPlaying,
    videoRef,
    canDrive && roomHasMedia && mediaStatus === 'ready',
    chooseCatalogStream,
  )

  const send = sync.send
  const sendChat = useCallback((text: string) => send('chat', { text }), [send])

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${room.id}`)
    } catch (error) {
      console.error('copy room link failed', error)
      return
    }
    toast(t('room.copiedToast'))
  }

  // The media getting ready, or failing, holds its own stage; the screens and
  // the live beside it play on.
  const mediaGate = shownGate !== null ? (
    <RoomGate
      inline
      step={gate}
      room={liveRoom}
      progress={uploadProgress}
      preparation={liveRoom.preparation}
      swarm={swarmStats}
      failure={uploadFailed}
      errorMessage={liveErrorText(liveRoom.errorMessage, t)}
    />
  ) : null

  const visibleRequests = sync.titleRequests.filter((request) => !dismissedRequests.includes(request.id)).slice(-3)

  const openRequestedTitle = (request: TitleRequest) => {
    setCatalogFocus({
      open: { meta: { id: request.metaId, type: request.metaType, name: request.name, poster: request.poster, releaseInfo: '' } },
      season: request.season,
      episode: request.episode,
    })
    setCatalogOpen(true)
  }

  const strings = useRoomStrings()
  const hosts = useStageHosts()
  const callSend = useCallback((message: CallMessage) => {
    const { type, ...payload } = message
    sync.send(type, payload)
  }, [sync.send])
  const call = useCall({
    roomId: room.id,
    memberId: sync.memberId,
    capability: sync.capability,
    send: callSend,
    members: sync.members,
    initial: initialMedia,
  })
  const { receive } = call
  useEffect(() => {
    if (sync.forced) receive({ type: 'forceMedia', ...sync.forced })
  }, [sync.forced, receive])
  const screenShare = useScreenShare({
    roomId: room.id,
    memberId: sync.memberId,
    nickname: selfNickname,
    capability: sync.capability,
    isController: sync.isController,
    shareOpen: mayShareScreen,
    screens,
    onScreenStarted: screenStartedNotice(toast, t),
  })
  useScreenShareNotices(screenShare, t)
  const [jlocalPickError, setJlocalPickError] = useState<string | null>(null)

  const people: Person[] = sync.members.map((member) => ({
    id: member.id,
    name: member.nickname,
    host: member.id === sync.controllerId,
    mic: member.id === sync.memberId ? call.mic : Boolean(member.mic),
    cam: member.id === sync.memberId ? call.cam : Boolean(member.cam),
    speaking: Boolean(call.speaking[member.id]),
    hostMuted: Boolean(member.hostMuted),
    hostCamOff: Boolean(member.hostCamOff),
    accountId: member.accountId || undefined,
    avatar: member.avatar || undefined,
  }))
  const roomStages = stagesOf(stageRoom)
  const viewStages: ViewStage[] = roomStages.map((stage) => ({
    id: stage.id,
    kind: stage.kind,
    title: stage.kind === 'screen' ? strings.screenOf.replace('{name}', stage.title) : stage.kind === 'live' ? stage.title || t('stage.kind.live') : liveRoom.fileName || nowPlaying?.name || t('stage.kind.media'),
    ownerId: stage.ownerId ?? '',
  }))
  const spotlight = currentSpotlight(stageRoom, sync.stages)
  const sources: ShareSource[] = [
    ...(screenShareSupported() && displayCaptureAvailable() ? ['screen' as const] : []),
    'file', 'torrent', 'youtube', 'drive', 'catalog',
  ]
  const memberIdByName = new Map(sync.members.map((member) => [member.nickname, member.id]))
  const { chat, reactions: serverReactions } = splitReactions(chatEntries.map((entry, index): ViewChatMessage => ({
    id: `${entry.at}:${index}`,
    authorId: entry.system ? '' : memberIdByName.get(entry.author) ?? entry.author,
    author: entry.author,
    text: entry.text,
    at: Date.parse(entry.at),
    system: entry.system,
  })))
  // The server stamps them; the tiles compare against this browser's clock.
  const reactions = serverReactions.map((reaction) => ({ ...reaction, at: reaction.at - sync.serverOffsetMs }))
  const mayOpen = (source: ShareSource) => source === 'screen' ? mayShareScreen : source === 'youtube' ? (mayOpenMedia || mayOpenLive) : mayOpenMedia

  const vm: RoomViewModel = {
    name: liveRoom.name || roomName || liveRoom.fileName || t('room.screenLabel'),
    link: `${window.location.host}/room/${room.id}`,
    startedAt: liveRoom.createdAt ? Date.parse(liveRoom.createdAt) : Date.now(),
    joinMode: (liveRoom.joinMode ?? 'open') as JoinMode,
    selfId: sync.memberId,
    isHost: sync.isController,
    people,
    stages: viewStages,
    spotlight: spotlight as RoomViewModel['spotlight'],
    requests: sync.isController ? sync.stages.requests.map((request) => ({ id: request.requestId, memberId: request.memberId, name: request.nickname, kind: request.kind })) : [],
    knocks: sync.isController ? sync.knocks.map((knock) => ({ id: knock.requestId, name: knock.nickname })) : [],
    chat,
    reactions,
    sources,
    levelOf: call.levelOf,
    actions: {
      setMic: call.setMic,
      setCam: call.setCam,
      share: (source) => {
        setSourceError('')
        if (source === 'catalog') { setCatalogFocus(null); setCatalogOpen(true); return }
        if (!mayOpen(source)) {
          if (!sync.stages.asked.includes(source === 'screen' ? 'screen' : 'media')) sync.requestStage(source === 'screen' ? 'screen' : 'media')
          toast(t('stage.waiting'))
          return
        }
        if (source === 'file') fileInputRef.current?.click()
        if (source === 'screen') {
          if (!screenShareSupported()) { setSourceError('error.screenUnsupported'); return }
          if (!isJLocalCaptureAvailable()) screenShare.start()
        }
      },
      react: (emoji) => { sendChat(emoji) },
      sendChat,
      leave: () => { leaveIdle(); window.location.assign('/') },
      copyLink: () => { void copyLink() },
      spotlight: (next) => { sync.setSpotlight(next as Parameters<typeof sync.setSpotlight>[0]) },
      answerRequest: (requestId, allow) => { sync.answerStage(requestId, allow) },
      admit: (knockId) => { sync.admit(knockId) },
      deny: (knockId) => { sync.deny(knockId) },
      hostMute: call.hostMute,
      hostCamOff: call.hostCamOff,
      kick: (memberId) => { sync.send('kick', { targetId: memberId }) },
      makeHost: (memberId) => { sync.send('transfer', { targetId: memberId }) },
      setAccess: (mode, password) => {
        void setRoomAccess(room.id, sync.memberId, sync.capability, mode, password)
          .then(() => sync.refreshRoom())
          .catch(() => toast(t('room.changeFailed')))
      },
      closeStage: (stage) => {
        if (stage.kind === 'screen' && stage.ownerId === sync.memberId) { screenShare.stop(); return }
        sync.closeStage(stage.kind, stage.kind === 'screen' ? stage.ownerId : undefined)
      },
      openProfile: (accountId) => navigate(`/u/${accountId}`),
    },
    slots: {
      renderVideo: (memberId) => <CallVideo memberId={memberId} />,
      renderStage: (stage) => hosts.slot(stage.id),
      renderStageTag: (stage) => stage.kind === 'media' && (uploadProgress !== null || swarmStats !== null || mediaStatus === 'ready')
        ? <PipelineChip swarm={swarmStats} progress={uploadProgress} remote={isRemoteProduction(room.id)} videoRef={videoRef} t={t} />
        : null,
      renderShare: (source, close) => {
        if (!mayOpen(source)) return null
        if (source === 'torrent') {
          return (
            <TorrentPicker
              maxFileBytes={MAX_UPLOAD_BYTES}
              t={t}
              onExit={close}
              onYoutubeLink={close}
              onPicked={(file, session) => { close(); chooseTorrent(file, session) }}
              initialMagnet={playlist?.magnet}
              autoLoad={playlist !== null}
              currentPath={playlist?.filePath}
            />
          )
        }
        if (source === 'drive') {
          return (
            <DrivePicker
              maxFileBytes={MAX_UPLOAD_BYTES}
              t={t}
              onPicked={(file, session) => { close(); chooseDrive(file, session) }}
            />
          )
        }
        if (source === 'youtube') {
          return <YoutubePicker t={t} onExit={close} onPicked={(session) => { close(); chooseYoutube(session) }} />
        }
        if (source === 'screen' && isJLocalCaptureAvailable()) {
          return (
            <JlocalPicker
              t={t}
              busy={screenShare.state === 'starting'}
              error={jlocalPickError}
              mode="start"
              onPick={(pick) => {
                setJlocalPickError(null)
                screenShare.startWithJlocal(pick).then(close).catch((failure: unknown) => {
                  const message = failure instanceof Error ? failure.message : ''
                  setJlocalPickError(t(message.includes('permission') ? 'jlocal.permission' : 'jlocal.failed'))
                })
              }}
              onExit={close}
            />
          )
        }
        return null
      },
    },
  }

  const mediaStage = roomStages.find((stage) => stage.kind === 'media')
  const mediaContent = mediaStage ? (
    <div className="stage-media">
      {mediaGate ?? (
        <Player
          room={liveRoom}
          isController={canDrive}
          memberId={sync.memberId}
          hostSubtitles={sync.hostSubtitles}
          videoRef={videoRef}
          send={sync.send}
          t={t}
          syncState={sync.state}
          serverOffsetMs={sync.serverOffsetMs}
          swarm={swarmStats}
          mediaOffsetMsRef={mediaOffsetMsRef}
          seekRef={playerSeekRef}
          coldWaitRef={coldWaitRef}
          coldForRef={coldForRef}
          remoteSteerAtRef={remoteSteerAtRef}
          autoplayBlocked={sync.autoplayBlocked}
          gatedStart={sync.waiting !== null}
          onBuffering={sync.reportBuffering}
          onWait={onWait}
          onChapters={() => setSidePanel((panel) => panel === 'chapters' ? null : 'chapters')}
          overlay={
            <>
              {sync.waiting !== null ? (
                <WaitingPanel
                  waiting={sync.waiting}
                  members={sync.members}
                  isController={sync.isController}
                  selfId={sync.memberId}
                  onIgnore={(memberId) => sync.send('ignore', { targetId: memberId })}
                  t={t}
                />
              ) : null}
              {nextEpisode.pending && nowPlaying ? (
                <NextEpisodeCard
                  video={nextEpisode.pending.video}
                  poster={nowPlaying.poster}
                  seconds={nextEpisode.seconds}
                  onPlayNow={nextEpisode.playNow}
                  onDismiss={nextEpisode.dismiss}
                />
              ) : null}
            </>
          }
        />
      )}
      {shownOpening !== null ? (
        <div className="stage-gate" data-leaving={openingGate === null || undefined}>
          <RoomGate
            inline
            step={openingGate ?? shownOpening}
            room={liveRoom}
            preparation={liveRoom.preparation}
            swarm={swarmStats}
            wait={openingWait}
          />
        </div>
      ) : null}
      {sidePanel === 'chapters' ? (
        <div className="stage-chapters">
          <ChaptersPanel
            chapters={liveRoom.chapters ?? []}
            open
            onClose={() => setSidePanel(null)}
            onSeek={canDrive ? (seconds) => {
              const throughPlayer = playerSeekRef.current
              if (throughPlayer) throughPlayer(seconds)
              else sync.send('seek', { positionMs: Math.round(seconds * 1000) })
            } : undefined}
            videoRef={videoRef}
            t={t}
          />
        </div>
      ) : null}
    </div>
  ) : null

  if (sync.door === 'password' || sync.door === 'badPassword') {
    return <PasswordAgain bad={sync.door === 'badPassword'} onAgain={onPasswordAgain} />
  }
  if (sync.door === 'denied') return <RoomGate step="denied" />
  if (sync.door === 'lobby') {
    return <WaitingRoom vm={{ name: vm.name, nickname, avatar: loadPickedAvatar() ?? undefined, cancel: () => { leaveIdle(); window.location.assign('/') } }} />
  }

  return (
    <CallProvider call={call}>
    <RoomView vm={vm} />
    {mediaStage ? hosts.portal('media', mediaContent) : null}
    {liveRoom.live ? hosts.portal('live', liveRoom.live.status === 'error' ? (
      <div className="player-wrap" style={{ display: 'grid', placeItems: 'center', padding: 16 }} role="alert">
        <p>{liveErrorText(liveRoom.live.error, t)}</p>
      </div>
    ) : (
      <LiveStage
        roomId={room.id}
        memberId={sync.memberId}
        capability={sync.capability}
        broadcast={liveRoom.live.broadcast}
        title={liveRoom.live.title}
        t={t}
      />
    )) : null}
    {roomStages.filter((stage) => stage.kind === 'screen').map((stage) => hosts.portal(stage.id, (
      <ScreenStage
        share={screenShare}
        only={stage.ownerId ?? ''}
        memberId={sync.memberId}
        viewers={sync.members.filter((member) => member.id !== sync.memberId).length}
        t={t}
      />
    )))}
    <input
      ref={fileInputRef}
      hidden
      type="file"
      accept="video/*,.mkv"
      onChange={(event) => chooseFile(event.target.files?.[0])}
    />
    {swapProbes.length > 0 && shownGate === 'preparing' ? <div className="swap-probes"><WorkerProbes probes={swapProbes} t={t} /></div> : null}
    {sourceError ? <div className="error-card compact" role="alert">{t(sourceError)}</div> : null}
    {visibleRequests.length > 0 ? (
      <div className="request-stack" aria-live="polite">
        {visibleRequests.map((request) => (
          <div key={request.id} className="request-card raised">
            {request.poster ? <img src={request.poster} alt="" /> : null}
            <div className="request-copy">
              <p><strong>{request.from}</strong> {t('request.asked')} <strong>{request.name}</strong>
                {request.season != null && request.episode != null && (request.season > 0 || request.episode > 0)
                  ? ` · S${String(request.season).padStart(2, '0')}E${String(request.episode).padStart(2, '0')}`
                  : ''}
              </p>
              {sync.isController ? (
                <button type="button" className="request-open" onClick={() => openRequestedTitle(request)}>
                  {t('request.viewSources')}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="dialog-close request-dismiss"
              aria-label={t('request.dismiss')}
              onClick={() => setDismissedRequests((current) => [...current, request.id])}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    ) : null}
    {catalogOpen ? (
      <Suspense fallback={null}>
        <CatalogOverlay
          mode={mayOpenMedia ? 'host' : 'viewer'}
          focus={catalogFocus}
          onClose={() => { setCatalogOpen(false); setCatalogFocus(null) }}
          onPickStream={chooseCatalogStream}
          onRequestTitle={(open, episode) => {
            sync.send('titleRequest', {
              title: {
                metaId: open.meta.id,
                metaType: open.meta.type,
                name: open.meta.name,
                poster: open.meta.poster,
                season: episode.season,
                episode: episode.episode,
              },
            })
          }}
        />
      </Suspense>
    ) : null}
    <StillThere
      deadlineMs={sync.stillThereDeadlineMs}
      serverOffsetMs={sync.serverOffsetMs}
      onStay={() => sync.send('stillHere')}
      onExpired={leaveIdle}
      t={t}
    />
    <Dialog open={sync.left} onOpenChange={() => undefined}>
      {sync.left ? (
        <DialogContent
          className="still-there-dialog"
          closeLabel={t('room.closedIdleHome')}
          title={t(sync.kicked ? 'room.kickedTitle' : 'room.closedIdleTitle')}
          description={t(sync.kicked ? 'room.kickedGuide' : 'room.closedIdleGuide')}
          onCloseClick={() => { window.location.assign("/") }}
        >
          <div className="closed-idle-actions">
            <button type="button" className="primary-button" autoFocus onClick={() => window.location.reload()}>
              {t('room.closedIdleRejoin')}
            </button>
            <Link className="secondary-button" to="/">{t('room.closedIdleHome')}</Link>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
    </CallProvider>
  )
}

/** A password room turned the hello away: back to the entrance for it. */
function PasswordAgain({ bad, onAgain }: { bad: boolean; onAgain: (bad: boolean) => void }) {
  useEffect(() => { onAgain(bad) }, [bad, onAgain])
  return <EntrySkeleton />
}

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

/** An arrival is audible as well as visible; a departure stays silent. */
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


/** A live's failure comes as a code; the page says it in words. */
function liveErrorText(message: string | undefined, t: Translator): string | undefined {
  if (!message) return message
  if (message === 'live_ended' || message.startsWith('youtube_')) return t(youtubeErrorKey(new YoutubeError(message)))
  return message
}
