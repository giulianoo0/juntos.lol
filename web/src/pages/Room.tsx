import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Room as LiveKitRoom } from 'livekit-client'
import { Chat } from '../chat/Chat'
import { ChaptersPanel } from '../player/ChaptersPanel'
import { StatusPill } from '../components/StatusPill'
import { CopyErrorReport } from '../components/CopyErrorReport'
import { StillThere } from '../components/StillThere'
import { caretToEndOnFocus } from '../ui/caret'
import { UploadAvailability, type OpeningWait } from '../components/UploadAvailability'
import { Check, Compass, Crown, FileVideo, Link2, MessageSquare, MonitorUp, Replace, Upload, UserX, X } from 'lucide-react'
import { useT, type Translator } from '../i18n/useT'
import { Player, regionHolds } from '../player/Player'
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
import { MorphingMenu } from '../ui/MorphingMenu'
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
  type RoomUploadProgress,
  remuxHandleFor,
  torrentStatsFor,
  uploadActive,
  resumableSourceFor,
  resumeSubtitleScan,
  clearResumableSource,
  sourceOriginFor,
} from '../upload'
import { expectedPositionMs } from '../player/position'
import type { TorrentStats } from '../torrent'

const COPIED_MS = 1_800
const PREPARING_POLL_MS = 3_000
// How long a pipeline may go quiet before the room counts as unproduced: long
// enough to outlast a cold seek, well short of the server's claim sweep.
const PRODUCER_ALIVE_MS = 90_000

export function RoomPage() {
  const { id = '' } = useParams()
  const [nickname, setNickname] = useState(() => localStorage.getItem('ss.nickname') || '')
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
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

type GateStep = 'connecting' | 'join' | 'expired' | 'preparing' | 'buffering' | 'failed' | 'error' | null

/** One panel that changes what it asks for, rather than swapping screens. */
function RoomGate({ step, room, onJoin, progress, preparation, swarm, wait, overlay = false, leaving = false, failure, errorMessage }: {
  step: GateStep
  room?: RoomInfo
  onJoin?: (nickname: string) => void
  progress?: RoomUploadProgress | null
  preparation?: RoomInfo['preparation']
  swarm?: TorrentStats | null
  wait?: OpeningWait | null
  /** Laid over the room rather than in place of it. */
  overlay?: boolean
  leaving?: boolean
  failure?: string | null
  errorMessage?: string
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const { shown, morphing } = useMorphingStep(step)
  return (
    <main className={`center-state${overlay ? ' gate-overlay' : ''}${leaving ? ' is-leaving' : ''}`}>
      <MorphPanel className="gate-panel raised" sizeKey={shown} morphing={morphing}>
        {shown === 'connecting' ? (
          <div className="gate-centered">
            <span className="stage-spinner" aria-hidden="true" />
            <StatusPill status="connecting" label={t('status.connecting')} />
          </div>
        ) : null}

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
    </main>
  )
}

// Mirrors the guest name the server hands out, so a blank field is valid.
function guestName(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const random = crypto.getRandomValues(new Uint8Array(6))
  return `Guest-${Array.from(random, (value) => alphabet[value % alphabet.length]).join('')}`
}

function ConnectedRoom({ room, nickname }: { room: RoomInfo; nickname: string }) {
  const t = useT()
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
  useEffect(() => {
    if (!sync.errorSeq) return
    if (sync.lastError === 'not_controller') toast(t('room.notController'))
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
  useEffect(() => {
    if (!producing || room.sourceKind !== 'upload') return
    void resumeSubtitleScan(room.id, liveRoom.mediaGeneration)
  }, [producing, room.sourceKind, room.id, liveRoom.mediaGeneration])
  const resumeTried = useRef(false)
  useEffect(() => {
    if (resumeTried.current || !sync.memberId || !sync.capability) return
    if (!needsPreparo) return
    if (room.sourceKind !== 'upload') { resumeTried.current = true; return }
    if (uploadActive(room.id) || remuxHandleFor(room.id)) return
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
        if (!torrentErrorRetryable(error)) clearResumableSource(room.id)
      }
    })()
  }, [needsPreparo, room.id, room.sourceKind, sync.memberId, sync.capability, t, toast])
  const [sidePanel, setSidePanel] = useState<'chat' | 'chapters' | null>('chat')
  const chatOpen = sidePanel === 'chat'
  const setChatOpen = (value: boolean | ((open: boolean) => boolean)) => {
    setSidePanel((panel) => {
      const next = typeof value === 'function' ? value(panel === 'chat') : value
      return next ? 'chat' : panel === 'chat' ? null : panel
    })
  }
  const [uploadProgress, setUploadProgress] = useState<RoomUploadProgress | null>(null)
  const [uploadFailed, setUploadFailed] = useState<string | null>(null)
  const mediaStatus = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status
  usePresenceNotices(sync.presence, t)
  const [sourcePanel, setSourcePanel] = useState<'torrent' | null>(null)
  const [readMark, setReadMark] = useState(() => sync.messages.length)
  const unread = chatOpen ? 0 : Math.max(0, sync.messages.length - readMark)
  const [sourceError, setSourceError] = useState<string>('')
  const [swapProbes, setSwapProbes] = useState<WorkerProbe[]>([])
  const [copied, setCopied] = useState(false)
  const { shown: copiedShown, morphing: copyMorphing } = useMorphingStep(copied)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isScreenRoom = liveRoom.sourceKind === 'screen'
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<Member | null>(null)
  const transferControls = (member: Member) => {
    if (liveRoom.sourceOrigin === 'file' && liveRoom.sourceMemberId === sync.memberId) setTransferTo(member)
    else sync.send('transfer', { targetId: member.id })
  }
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
  const openingGate: GateStep = opening && !isScreenRoom && mediaStatus === 'ready' ? 'buffering' : null
  const { shown: shownOpening } = useMorphingStep(openingGate)

  const swapSource = async (run: () => Promise<void>) => {
    setSourceError('')
    setSourcePanel(null)
    setSwapProbes([])
    try {
      await run()
    } catch (error) {
      console.error('change source failed', error)
      setSourceError(isTorrentError(error) ? torrentErrorKey(error) : 'room.changeFailed')
    }
  }

  const chooseFile = (file?: File) => {
    if (!file) return
    void swapSource(async () => {
      await assertReadable(file)
      const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', file.name)
      startFileUpload(room.id, next.mediaGeneration, file)
    })
  }

  const chooseTorrent = (file: TorrentVideoFile, session: TorrentSession) => {
    void swapSource(async () => {
      let next
      try {
        next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', file.name)
      } catch (error) {
        session.destroy()
        throw error
      }
      startTorrentUpload(room.id, next.mediaGeneration, { file, session }, undefined, { memberId: sync.memberId, capability: sync.capability })
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
        const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', pick.displayName)
        startUrlUpload(room.id, next.mediaGeneration, url, `${pick.displayName}.mkv`, 0)
        return
      }
      const opened = await openCatalogStream(pick.stream, pick.target, undefined, { onProbe: setSwapProbes })
      try {
        const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', pick.displayName)
        startTorrentUpload(room.id, next.mediaGeneration, opened, undefined, { memberId: sync.memberId, capability: sync.capability })
      } catch (error) {
        opened.session.destroy()
        throw error
      }
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
      if (!isScreenShareCancelled(error)) setSourceError('changeFailed')
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
      void fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal })
        .then(async (response) => { if (response.ok) setLiveRoom(await response.json() as RoomInfo) })
        .catch(() => undefined)
    }, PREPARING_POLL_MS)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [preparing, sync.connected, room.id])

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
    sync.isController && !isScreenRoom && mediaStatus === 'ready',
    chooseCatalogStream,
  )

  const closeChat = useCallback(() => setChatOpen(false), [])
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
    setCopied(true)
  }
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (shownGate !== null) {
    return (
      <RoomGate
        step={gate}
        room={liveRoom}
        progress={uploadProgress}
        preparation={liveRoom.preparation}
        swarm={swarmStats}
        failure={uploadFailed}
        errorMessage={liveRoom.errorMessage}
      />
    )
  }

  const visibleRequests = sync.titleRequests.filter((request) => !dismissedRequests.includes(request.id)).slice(-3)

  const openRequestedTitle = (request: TitleRequest) => {
    setCatalogFocus({
      open: { meta: { id: request.metaId, type: request.metaType, name: request.name, poster: request.poster, releaseInfo: '' } },
      season: request.season,
      episode: request.episode,
    })
    setCatalogOpen(true)
  }

  return (
    <>
    {shownOpening !== null ? (
      <RoomGate
        overlay
        leaving={openingGate === null}
        step={openingGate}
        room={liveRoom}
        preparation={liveRoom.preparation}
        swarm={swarmStats}
        wait={openingWait}
      />
    ) : null}
    <main className="room-shell room-enter">
      <header className="room-header">
        <div className="room-heading"><span className="room-file">{isScreenRoom ? t('room.screenLabel') : liveRoom.fileName}</span></div>
        <div className="header-actions">
          {!isScreenRoom && (uploadProgress !== null || swarmStats !== null || mediaStatus === 'ready')
            ? <PipelineChip swarm={swarmStats} progress={uploadProgress} remote={isRemoteProduction(room.id)} videoRef={videoRef} t={t} />
            : null}
          {uploadFailed !== null ? <span className="upload-chip is-error">{t('room.uploadFailed')}</span> : null}
          <StatusPill status={sync.buffering ? 'buffering' : sync.connected ? 'live' : 'connecting'} label={t(sync.buffering ? 'status.buffering' : sync.connected ? 'status.live' : 'status.connecting')} />
          {sync.isController && !isScreenRoom ? (
            <Button
              className={`sync-toggle ${sync.gatingEnabled ? 'is-on' : ''}`}
              variant="ghost"
              size="small"
              role="switch"
              aria-checked={sync.gatingEnabled}
              onClick={() => {
                if (!sync.send('gating', { enabled: !sync.gatingEnabled })) toast(t('room.offlineCommand'))
              }}
            >
              <span className="sync-toggle-box" aria-hidden="true">
                {sync.gatingEnabled ? <Check size={11} strokeWidth={3.5} /> : null}
              </span>
              {t('room.gating')}
            </Button>
          ) : null}
          {sync.isController ? (
            <MediaSwitch
              t={t}
              onOpen={() => setSourceError('')}
              onCatalog={() => { setCatalogFocus(null); setCatalogOpen(true) }}
              onTorrent={() => setSourcePanel('torrent')}
              onFile={() => fileInputRef.current?.click()}
              onScreen={chooseScreen}
            />
          ) : (
            <Button className="catalog-open" onClick={() => { setCatalogFocus(null); setCatalogOpen(true) }}>
              <Compass size={15} aria-hidden="true" />{t('catalog.tab')}
            </Button>
          )}
          <IconButton
            icon={
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
      <div className={`room-layout ${sidePanel !== null ? 'chat-open' : ''}`}>
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
              onChapters={() => setSidePanel((panel) => panel === 'chapters' ? 'chat' : 'chapters')}
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
          <div className="presence-row">
            {sync.members.map((member) => (
              <MemberChip
                key={member.id}
                member={member}
                isController={member.id === sync.controllerId}
                holdsFile={liveRoom.sourceOrigin === 'file' && member.id === liveRoom.sourceMemberId}
                canAct={sync.isController && member.id !== sync.memberId}
                onTransfer={() => transferControls(member)}
                onKick={() => sync.send('kick', { targetId: member.id })}
                t={t}
              />
            ))}
          </div>
        </section>
        {sidePanel === 'chapters' ? (
          <ChaptersPanel
            chapters={liveRoom.chapters ?? []}
            open
            onClose={() => setSidePanel('chat')}
            onSeek={sync.isController ? (seconds) => {
              const throughPlayer = playerSeekRef.current
              if (throughPlayer) throughPlayer(seconds)
              else sync.send('seek', { positionMs: Math.round(seconds * 1000) })
            } : undefined}
            videoRef={videoRef}
            t={t}
          />
        ) : (
          <Chat open={chatOpen} onClose={closeChat} messages={chatEntries} onSend={sendChat} t={t} />
        )}
      </div>
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
            mode={sync.isController ? 'host' : 'viewer'}
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
      <Dialog open={transferTo !== null} onOpenChange={(open) => { if (!open) setTransferTo(null) }}>
        {transferTo ? (
          <DialogContent
            className="still-there-dialog"
            closeLabel={t('room.transferCancel')}
            title={t('room.transferFileTitle')}
            description={t('room.transferFileGuide')}
            onCloseClick={() => setTransferTo(null)}
          >
            <div className="closed-idle-actions">
              <button
                type="button"
                className="primary-button"
                autoFocus
                onClick={() => { sync.send('transfer', { targetId: transferTo.id }); setTransferTo(null) }}
              >
                {t('room.transferConfirm')}
              </button>
              <button type="button" className="secondary-button" onClick={() => setTransferTo(null)}>
                {t('room.transferCancel')}
              </button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
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
      <Dialog open={sourcePanel !== null} onOpenChange={(open) => { if (!open) setSourcePanel(null) }}>
        {sourcePanel !== null ? (
          <DialogContent
            className="torrent-dialog"
            closeLabel={t('home.closeDialog')}
            hideTitle
            title={t('home.torrentTitle')}
          >
            <TorrentPicker
              maxFileBytes={MAX_UPLOAD_BYTES}
              t={t}
              onExit={() => setSourcePanel(null)}
              onPicked={chooseTorrent}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </main>
    </>
  )
}

// The film icon marks whose computer the video is on; for the controller, a
// right-click opens what can be done to that person.
function MemberChip({ member, isController, holdsFile, canAct, onTransfer, onKick, t }: {
  member: Member
  isController: boolean
  holdsFile: boolean
  canAct: boolean
  onTransfer: () => void
  onKick: () => void
  t: Translator
}) {
  const className = `member-chip ${isController ? 'is-controller' : ''}`
  const body = (
    <>
      {member.nickname}
      {isController ? <Crown size={12} aria-hidden="true" /> : null}
      {holdsFile ? (
        <span className="member-holds-file" title={t('room.holdsFile').replace('{name}', member.nickname)}>
          <FileVideo size={12} aria-hidden="true" />
        </span>
      ) : null}
    </>
  )
  if (!canAct) return <span className={className}>{body}</span>
  const pick = (close: () => void, action: () => void) => () => { close(); action() }
  return (
    <MorphingMenu
      openOn="contextmenu"
      haspopup="menu"
      minWidth={0}
      ariaLabel={t('room.memberMenu').replace('{name}', member.nickname)}
      triggerClassName={className}
      panelClassName="media-switch-panel"
      trigger={() => body}
    >
      {(close) => (
        <div className="media-switch-menu">
          <button type="button" onClick={pick(close, onTransfer)}>
            <Crown size={15} aria-hidden="true" />{t('room.transferHost')}
          </button>
          <button type="button" onClick={pick(close, onKick)}>
            <UserX size={15} aria-hidden="true" />{t('room.kickMember')}
          </button>
        </div>
      )}
    </MorphingMenu>
  )
}

/** The one entry point for putting something else on, as a MorphingMenu. */
function MediaSwitch({ onOpen, onCatalog, onTorrent, onFile, onScreen, t }: {
  onOpen: () => void
  onCatalog: () => void
  onTorrent: () => void
  onFile: () => void
  onScreen: () => void
  t: Translator
}) {
  const pick = (close: () => void, action: () => void) => () => { close(); action() }
  return (
    <MorphingMenu
      align="end"
      haspopup="menu"
      minWidth={0}
      onOpen={onOpen}
      triggerClassName="media-switch-pill"
      panelClassName="media-switch-panel"
      trigger={() => <><Replace size={15} aria-hidden="true" />{t('room.changeMedia')}</>}
    >
      {(close) => (
        <div className="media-switch-menu">
          <button type="button" onClick={pick(close, onCatalog)}>
            <Compass size={15} aria-hidden="true" />{t('catalog.tab')}
          </button>
          <button type="button" onClick={pick(close, onTorrent)}>
            <span className="magnet-glyph" aria-hidden="true">µ</span>{t('room.switchTorrent')}
          </button>
          <button type="button" onClick={pick(close, onFile)}>
            <Upload size={15} aria-hidden="true" />{t('room.switchFile')}
          </button>
          <button type="button" onClick={pick(close, onScreen)}>
            <MonitorUp size={15} aria-hidden="true" />{t('room.switchScreen')}
          </button>
        </div>
      )}
    </MorphingMenu>
  )
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

/**
 * Everyone joins the WebRTC session as a subscriber; the controller publishes
 * from inside its own click and attaches its own track locally, since a
 * publisher is never subscribed to itself.
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

