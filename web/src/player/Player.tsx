import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  FastForward, Lock, Maximize, Minimize, Pause, Play, Rewind,
  SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from 'lucide-react'
import { NumberFlowGroup } from '@number-flow/react'
import type Hls from 'hls.js'
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import type { MediaRegion, PlayState, RoomInfo, TrackInfo } from '../types'
import type { Translator } from '../i18n/useT'
import { audioTrackLabel } from './audioTracks'
import { expectedPositionMs } from './position'
import { heading, inBox } from './safeHover'
import { MAX_RECOVERIES, nextRecovery, type Recoveries } from './recovery'
import { Settings, type SettingGroup } from './Settings'
import { AssLayer } from './AssLayer'
import { SubtitleLayer } from './SubtitleLayer'
import { Timecode } from './Timecode'
import { MOCK_AUDIO_TRACKS, MOCK_LEVELS, mocksEnabled } from '../mocks'
import { TorrentReadout } from '../components/TorrentReadout'
import { WaitLabel } from './WaitLabel'
import { bufferAhead, holdsForBuffer } from './bufferAhead'
import { gateSecondsFor } from './gate'
import { bundledLoader, fetchBundle, prefetchInitSegments } from './bundle'
import { prefetchingLoader } from './prefetch'
import { createSeekTracer, formatSeekTrace } from '../pipeline/seekTrace'
import { CopyErrorReport } from '../components/CopyErrorReport'
import { lastUploadFailureDetail } from '../upload'
import type { TorrentStats } from '../torrent'
import { useToast } from '../ui/toastContext'

interface PlayerProps {
  room: RoomInfo
  isController: boolean
  videoRef: MutableRefObject<HTMLVideoElement | null>
  send: (type: string, payload?: Record<string, unknown>) => void
  t: Translator
  syncState?: PlayState
  serverOffsetMs?: number
  swarm?: TorrentStats | null
  overlay?: ReactNode
  onChapters?: () => void
  mediaOffsetMsRef?: MutableRefObject<number>
  seekRef?: MutableRefObject<((seconds: number) => void) | null>
  coldWaitRef?: MutableRefObject<boolean>
  coldForRef?: MutableRefObject<((ms: number) => boolean) | null>
  remoteSteerAtRef?: MutableRefObject<number>
  autoplayBlocked?: boolean
  gatedStart?: boolean
  onBuffering?: (stalled: boolean) => void
  onWait?: (wait: { secondsLeft: number | null; cold: boolean }) => void
}

const REGION_AHEAD_MS = 30_000
const PLAY_INTENT_TTL_MS = 5_000
const REMOTE_ECHO_MS = 500
const REGION_BEHIND_MS = 1_000

export function regionHolds(region: MediaRegion, ms: number): boolean {
  const end = region.startMs + region.producedMs + (region.growing ? REGION_AHEAD_MS : 0)
  return ms >= region.startMs - REGION_BEHIND_MS && ms <= end
}

/**
 * The region to load for a position: the one already loaded if it still
 * holds it, else the newest region that does, else the growing one when the
 * position is ahead of it (it will get there), else whatever is loaded.
 */
export function regionFor(regions: MediaRegion[], ms: number, current: number | null): number | null {
  if (regions.length === 0) return null
  const loaded = regions.find((r) => r.n === current)
  if (loaded && regionHolds(loaded, ms)) return loaded.n
  const holding = regions.filter((r) => regionHolds(r, ms))
  if (holding.length > 0) return holding.reduce((a, b) => (b.startMs > a.startMs ? b : a)).n
  const growing = regions.find((r) => r.growing)
  if (growing && ms >= growing.startMs - REGION_BEHIND_MS) return growing.n
  return loaded ? loaded.n : (growing ?? regions[regions.length - 1]).n
}

/**
 * The version that is allowed to rebuild the player. A region that is growing
 * or sealed republishes constantly with nothing to rebuild for, so only a room
 * with no region map reloads on the room's media version.
 */
export function reloadVersion(region: { growing?: boolean } | null, version: number | undefined): number {
  if (region) return 0
  return version ?? 0
}

const TAP_TOGGLE_DELAY_MS = 200

const NO_SUBTITLE_TRACKS: NonNullable<RoomInfo['subtitleTracks']> = []

const SEEK_STEP_SECONDS = 5
const SEEK_STEP_LARGE_SECONDS = 10
const VOLUME_STEP = 0.05
const VOLUME_CHASE_MS = 500
const FEEDBACK_MS = 700
const FRAME_WATCH_INTERVAL_MS = 1000
const MANIFEST_RETRY_MS = 2000
const VIDEO_STARVATION_SECONDS = 5
const LIVE_SYNC_THRESHOLD_MS = 1000

const viewerTrace = createSeekTracer((trace) => console.info(formatSeekTrace('viewer', trace)))

export interface BufferedRange {
  start: number
  end: number
}

function assSource(room: RoomInfo, track: TrackInfo): string {
  const version = `?g=${room.mediaGeneration}&s=${track.digest ?? room.subsVersion ?? 0}`
  return `${room.mediaBaseUrl}/subs/sub_${track.index}_${safeLanguage(track.language)}.ass${version}`
}

function subtitleSource(room: RoomInfo, track: TrackInfo): string {
  const version = `?g=${room.mediaGeneration}&s=${track.digest ?? room.subsVersion ?? 0}`
  return `${room.mediaBaseUrl}/subs/sub_${track.index}_${safeLanguage(track.language)}.vtt${version}`
}

export function Player({ room, isController, videoRef, send, t, syncState, serverOffsetMs = 0, swarm, overlay, onChapters, mediaOffsetMsRef, seekRef, coldWaitRef, coldForRef, remoteSteerAtRef, autoplayBlocked, gatedStart = false, onBuffering, onWait }: PlayerProps) {
  const { toast } = useToast()
  const refuseControl = useCallback(() => toast(t('room.controllerOnly')), [t, toast])
  const playerRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const syncRef = useRef<PlayState | undefined>(syncState)
  syncRef.current = syncState
  const serverOffsetRef = useRef(serverOffsetMs)
  serverOffsetRef.current = serverOffsetMs
  const loadedOffsetSecRef = useRef(0)
  const playRequestedRef = useRef(false)
  const playRequestedAtRef = useRef(0)
  const playAttemptRef = useRef(false)
  const resumeAfterReloadRef = useRef(false)
  const [needsGesture, setNeedsGesture] = useState(false)
  const needsGestureRef = useRef(false)
  needsGestureRef.current = needsGesture
  const controlsTimerRef = useRef<number | null>(null)
  const feedbackSeqRef = useRef(0)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>(
    () => (mocksEnabled ? MOCK_AUDIO_TRACKS : []),
  )
  const [levels, setLevels] = useState<Array<{ height: number; bitrate: number }>>(
    () => (mocksEnabled ? MOCK_LEVELS : []),
  )
  const [level, setLevel] = useState(-1)
  const [subtitle, setSubtitle] = useState(-1)
  const [audioTrack, setAudioTrack] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [scrubSec, setScrubSec] = useState<number | null>(null)
  const [pendingSeekSec, setPendingSeekSec] = useState<number | null>(null)
  const scrubbingRef = useRef(false)
  const regions = room.mediaRegions && room.mediaRegions.length > 0 ? room.mediaRegions : null
  const [activeRegionN, setActiveRegionN] = useState<number | null>(() => {
    if (!room.mediaRegions || room.mediaRegions.length === 0) return null
    const wantedMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : 0
    return regionFor(room.mediaRegions, wantedMs, null)
  })
  const activeRegion = regions?.find((r) => r.n === activeRegionN) ?? null
  const mediaOffsetMs = activeRegion ? activeRegion.startMs : (room.mediaOffsetMs ?? 0)
  const mediaOffsetSec = mediaOffsetMs / 1000
  const masterName = activeRegion ? `r${activeRegion.n}_master.m3u8` : 'master.m3u8'
  const mediaReload = reloadVersion(activeRegion, room.mediaVersion)
  useEffect(() => {
    if (!regions) { setActiveRegionN(null); return }
    const video = videoRef.current
    const wantedMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs)
      : video ? video.currentTime * 1000 + mediaOffsetMs : 0
    const next = regionFor(regions, wantedMs, activeRegionN)
    if (next !== null && next !== activeRegionN) setActiveRegionN(next)
  }, [regions, syncState, serverOffsetMs, activeRegionN, mediaOffsetMs, videoRef])
  const coldTargetMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : null
  const coldRegions = regions ?? (duration > 0
    ? [{ n: 0, startMs: mediaOffsetMs, producedMs: Math.round(duration * 1000), growing: true }]
    : null)
  const knownEndMs = room.durationMs && room.durationMs > 0 ? room.durationMs : null
  const producedToEnd = knownEndMs !== null && coldRegions !== null
    && coldRegions.some((r) => regionHolds(r, knownEndMs - 1))
  const coldFor = (ms: number): boolean => coldRegions !== null
    && !(producedToEnd && ms >= (knownEndMs ?? 0))
    && !coldRegions.some((r) => regionHolds(r, ms))
  const coldWait = coldTargetMs !== null && coldFor(coldTargetMs)
  if (coldWaitRef) coldWaitRef.current = coldWait
  if (coldForRef) coldForRef.current = coldFor
  useEffect(() => {
    if (!coldWait) {
      viewerTrace.mark('coldWaitEnd')
      hlsRef.current?.startLoad()
      return
    }
    viewerTrace.begin(coldTargetMs ?? 0)
    playRequestedRef.current = false
    videoRef.current?.pause()
    hlsRef.current?.stopLoad()
  }, [coldWait, videoRef])
  const shownSec = coldWait && coldTargetMs !== null ? coldTargetMs / 1000 : currentTime

  const timelineEnd = room.durationMs ? room.durationMs / 1000 : duration + mediaOffsetSec
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([])
  const [playing, setPlaying] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeOpenRef = useRef(false)
  volumeOpenRef.current = volumeOpen
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [feedback, setFeedback] = useState<{ id: number; node: ReactNode } | null>(null)
  const [unplayable, setUnplayable] = useState<{ cause: 'codec' | 'playback'; reason: string } | null>(null)
  const recoveriesRef = useRef<Recoveries>({ spent: 0, atMs: 0 })
  const resumeRef = useRef({ generation: -1, time: 0 })

  const lastRevealRef = useRef(0)
  const revealControls = useCallback((autoHide = true) => {
    const now = performance.now()
    if (volumeOpenRef.current) {
      if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
      controlsTimerRef.current = null
      setControlsVisible(true)
      return
    }
    if (autoHide && controlsTimerRef.current !== null && now - lastRevealRef.current < 150) return
    lastRevealRef.current = now
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    setControlsVisible(true)
    if (!autoHide) {
      controlsTimerRef.current = null
      return
    }
    controlsTimerRef.current = window.setTimeout(() => {
      controlsTimerRef.current = null
      setControlsVisible(false)
    }, 2500)
  }, [])

  const showFeedback = useCallback((node: ReactNode) => {
    feedbackSeqRef.current += 1
    setFeedback({ id: feedbackSeqRef.current, node })
  }, [])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [feedback])

  useEffect(() => {
    if (playing && !volumeOpen) revealControls()
    else revealControls(false)
    return () => {
      if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    }
  }, [playing, volumeOpen, revealControls])

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const sync = () => {
      setVolume(video.volume)
      setMuted(video.muted)
    }
    sync()
    video.addEventListener('volumechange', sync)
    return () => video.removeEventListener('volumechange', sync)
  }, [videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const generation = room.mediaGeneration
    const source = `/media/${encodeURIComponent(room.id)}/hls/${masterName}?g=${generation}&v=${mediaReload}`
    const bundle = fetchBundle(room.id, masterName)
    void bundle.then(prefetchInitSegments)
    let disposed = false
    setUnplayable(null)
    const sync = syncRef.current
    const resumeAbs = resumeRef.current.generation === generation ? resumeRef.current.time : 0
    const wantedAbs = sync ? expectedPositionMs(sync, Date.now() + serverOffsetRef.current) / 1000 : resumeAbs
    const startPosition = Math.max(wantedAbs - mediaOffsetSec, 0)
    loadedOffsetSecRef.current = mediaOffsetSec
    if (mediaOffsetMsRef) mediaOffsetMsRef.current = mediaOffsetMs

    const failPlayback = (reason: string, cause: 'codec' | 'playback' = 'playback') => {
      if (disposed) return
      plog('error', `giving up: ${reason}`)
      hlsRef.current?.destroy()
      hlsRef.current = null
      setLevels([])
      setLevel(-1)
      setUnplayable({ cause, reason })
    }

    let lastTime = video.currentTime
    let lastFrames = -1
    let starvedSeconds = 0
    const watchdog = window.setInterval(() => {
      if (typeof video.getVideoPlaybackQuality !== 'function') return
      const advanced = Math.min(Math.max(video.currentTime - lastTime, 0), FRAME_WATCH_INTERVAL_MS / 1000)
      lastTime = video.currentTime
      const frames = video.getVideoPlaybackQuality().totalVideoFrames
      if (frames !== lastFrames) {
        lastFrames = frames
        starvedSeconds = 0
        return
      }
      if (video.paused || advanced <= 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      starvedSeconds += advanced
      if (starvedSeconds < VIDEO_STARVATION_SECONDS) return
      const decodedBefore = frames > 0
      if (!decodedBefore && video.videoWidth > 0) {
        plog('warn', 'frame counter is not reported by this platform; watchdog disabled')
        window.clearInterval(watchdog)
        return
      }
      window.clearInterval(watchdog)
      plog('error', `clock advanced ${starvedSeconds.toFixed(1)}s with no new video frames (total ${frames}, videoWidth ${video.videoWidth})`)
      failPlayback('video frames stopped while playback advanced')
    }, FRAME_WATCH_INTERVAL_MS)

    void import('hls.js').then(({ default: HlsClass, ErrorTypes, ErrorDetails }) => {
      if (disposed) return
      if (!HlsClass.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          plog('info', 'using native HLS', source)
          video.src = source
          if (startPosition > 0) video.currentTime = startPosition
          return
        }
        failPlayback('this browser supports neither MediaSource HLS nor native HLS', 'codec')
        return
      }

      const logLevels = (hls: InstanceType<HlsModule['default']>, note: string) => {
        for (const level of hls.levels) {
          const codecs = [level.videoCodec, level.audioCodec].filter(Boolean).join(',')
          const supported = typeof MediaSource === 'undefined'
            ? 'unknown'
            : MediaSource.isTypeSupported(`video/mp4;codecs="${codecs}"`)
          plog('info', `${note} level ${level.width}x${level.height} codecs="${codecs}" mediasource-supported=${String(supported)}`)
        }
      }

      const buildPlayer = (stripCodecs: boolean) => {
        const config: Partial<HlsConfig> = {
          startPosition,
          maxBufferLength: 60,
          maxBufferSize: 160 * 1000 * 1000,
        }
        const bundled = bundledLoader(HlsClass.DefaultConfig.loader as Parameters<typeof bundledLoader>[0], bundle)
        config.pLoader = stripCodecs ? codecStrippingLoader(bundled as HlsModule['default']['DefaultConfig']['loader']) : bundled
        config.fLoader = prefetchingLoader(HlsClass.DefaultConfig.loader as Parameters<typeof prefetchingLoader>[0])
        const hls = new HlsClass(config)
        hlsRef.current = hls
        let sourceLoaded = false
        hls.on(HlsClass.Events.MEDIA_ATTACHED, () => {
          if (sourceLoaded) return
          sourceLoaded = true
          hls.loadSource(source)
        })
        const readLevels = () => setLevels(hls.levels.map(
          ({ height, bitrate }) => ({ height, bitrate })))
        hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
          setAudioTracks(hls.audioTracks)
          readLevels()
          logLevels(hls, 'parsed')
          if (viewerTrace.has('coldWaitEnd')) viewerTrace.mark('manifestParsed')
        })
        hls.on(HlsClass.Events.FRAG_BUFFERED, () => { if (viewerTrace.has('coldWaitEnd')) viewerTrace.mark('firstFragBuffered') })
        if (typeof video.requestVideoFrameCallback === 'function') {
          const onFrame = () => {
            if (viewerTrace.has('coldWaitEnd')) viewerTrace.mark('firstFrame')
            else if (viewerTrace.open()) video.requestVideoFrameCallback(onFrame)
          }
          video.requestVideoFrameCallback(onFrame)
        }
        hls.on(HlsClass.Events.LEVELS_UPDATED, () => {
          readLevels()
          logLevels(hls, 'updated')
        })
        hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => setAudioTracks(hls.audioTracks))
        hls.on(HlsClass.Events.BUFFER_CREATED, (_event, data) =>
          plog('info', `source buffers created: ${Object.keys(data.tracks).join(', ') || 'none'}`))
        const undecodable = new Set<string>([
          ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
          ErrorDetails.BUFFER_ADD_CODEC_ERROR,
        ])
        hls.on(HlsClass.Events.ERROR, (_event, data) => {
          plog(data.fatal ? 'error' : 'warn',
            `hls ${data.fatal ? 'fatal' : 'non-fatal'} error ${data.type}/${data.details}`,
            data.reason ?? data.error?.message ?? '')
          if (!data.fatal) {
            if (data.details === ErrorDetails.BUFFER_ADD_CODEC_ERROR && data.sourceBufferName !== 'audio') {
              const failed = data.mimeType ?? ''
              const alternate = hls.levels.some((level) => level.videoCodec && !failed.includes(level.videoCodec))
              if (!alternate) failPlayback(`no decodable video rendition (${failed})`, 'codec')
            }
            return
          }
          if (data.details === ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) {
            if (!stripCodecs) {
              plog('warn', 'every CODECS string was rejected; retrying without the prediction')
              hls.destroy()
              if (!disposed) buildPlayer(true)
              return
            }
            failPlayback('no compatible codecs in manifest', 'codec')
            return
          }
          if (undecodable.has(data.details)) {
            failPlayback(`undecodable media (${data.details})`, 'codec')
            return
          }
          if (data.type === ErrorTypes.NETWORK_ERROR) {
            if (data.details === ErrorDetails.MANIFEST_LOAD_ERROR || data.details === ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
              window.setTimeout(() => {
                if (!disposed && hlsRef.current === hls) hls.loadSource(source)
              }, MANIFEST_RETRY_MS)
              return
            }
            hls.startLoad()
            return
          }
          if (data.type === ErrorTypes.MEDIA_ERROR) {
            const next = nextRecovery(recoveriesRef.current, Date.now())
            if (next !== null) {
              recoveriesRef.current = next
              plog('warn', `attempting media error recovery ${next.spent}/${MAX_RECOVERIES}`)
              hls.recoverMediaError()
              return
            }
          }
          failPlayback(`unrecoverable ${data.type}/${data.details}`)
        })
        hls.attachMedia(video)
      }
      buildPlayer(false)
    })
    return () => {
      disposed = true
      window.clearInterval(watchdog)
      resumeRef.current = { generation, time: video.currentTime + loadedOffsetSecRef.current }
      resumeAfterReloadRef.current = syncRef.current?.playing ?? !video.paused
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, room.mediaGeneration, mediaReload, mediaOffsetSec, masterName, videoRef])

  useEffect(() => { resumeAfterReloadRef.current = false }, [room.mediaGeneration])

  const subtitleTracks = room.subtitleTracks ?? NO_SUBTITLE_TRACKS
  const subtitleCount = subtitleTracks.length
  const chosenSubtitleTrack = subtitleTracks.find((track) => track.index === subtitle) ?? null
  const assChosen = chosenSubtitleTrack !== null && chosenSubtitleTrack.codec === 'ass' && !!room.mediaBaseUrl
  const [assFailed, setAssFailed] = useState(false)
  const assFontUrls = useMemo(
    () => (room.mediaBaseUrl ? (room.subtitleFonts ?? []).map((font) => `${room.mediaBaseUrl}/subs/${font.file}`) : []),
    [room.mediaBaseUrl, room.subtitleFonts],
  )
  useEffect(() => {
    const textTracks = videoRef.current?.textTracks
    if (!textTracks) return
    const chosen = subtitleTracks.findIndex((track) => track.index === subtitle)
    for (let position = 0; position < Math.min(textTracks.length, subtitleCount); position += 1) {
      textTracks[position].mode = position === chosen ? 'hidden' : 'disabled'
    }
  }, [subtitle, subtitleCount, subtitleTracks, room.subsVersion, room.mediaGeneration, mediaReload, videoRef])

  const commandPositionMs = useCallback((video: HTMLVideoElement): number => {
    const elementMs = Math.round((video.currentTime + loadedOffsetSecRef.current) * 1000)
    const sync = syncRef.current
    if (!sync) return elementMs
    const expected = expectedPositionMs(sync, Date.now() + serverOffsetRef.current)
    return Math.abs(elementMs - expected) > 5_000 ? Math.round(expected) : elementMs
  }, [])

  const localPlayRef = useRef(false)

  const attemptPlay = useCallback(() => {
    const video = videoRef.current
    if (!video || !playRequestedRef.current || playAttemptRef.current) return
    if (Date.now() - playRequestedAtRef.current > PLAY_INTENT_TTL_MS) {
      playRequestedRef.current = false
      return
    }
    if (!isController && syncRef.current && !syncRef.current.playing) {
      playRequestedRef.current = false
      return
    }
    if (bufferGateRef.current) {
      playRequestedAtRef.current = Date.now()
      return
    }
    playAttemptRef.current = true
    void Promise.resolve(video.play()).then(() => {
      playAttemptRef.current = false
      setNeedsGesture(false)
      if (!playRequestedRef.current) return
      playRequestedRef.current = false
      const local = localPlayRef.current
      localPlayRef.current = false
      if (isController && !local) {
        send('play', { positionMs: commandPositionMs(video), rate: video.playbackRate })
      }
    }).catch((error: unknown) => {
      playAttemptRef.current = false
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        playRequestedRef.current = false
        setNeedsGesture(true)
      }
    })
  }, [commandPositionMs, isController, send, videoRef])

  const requestPlay = useCallback(() => {
    playRequestedRef.current = true
    playRequestedAtRef.current = Date.now()
    attemptPlay()
  }, [attemptPlay])

  const catchUp = useCallback(() => {
    const video = videoRef.current
    if (!video || !video.paused || playRequestedRef.current) return
    if (needsGestureRef.current) return
    if (!syncRef.current?.playing || coldWaitRef?.current) return
    localPlayRef.current = true
    requestPlay()
  }, [coldWaitRef, requestPlay, videoRef])

  const notReadyRef = useRef(false)
  const [opened, setOpened] = useState(false)
  const seekBusyRef = useRef(false)

  useEffect(() => { catchUp() }, [catchUp, syncState, coldWait])

  const wasColdRef = useRef(false)
  useEffect(() => {
    const wasCold = wasColdRef.current
    wasColdRef.current = coldWait
    if (coldWait || !wasCold || !syncRef.current?.playing) return
    const video = videoRef.current
    if (!video || !video.paused) return
    requestPlay()
  }, [coldWait, requestPlay, videoRef])

  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingTap = useCallback(() => {
    if (tapTimerRef.current === null) return
    clearTimeout(tapTimerRef.current)
    tapTimerRef.current = null
  }, [])
  useEffect(() => cancelPendingTap, [cancelPendingTap])

  const resumeAtMsRef = useRef<number | null>(null)

  const togglePlay = useCallback((): boolean => {
    const video = videoRef.current
    if (!video) return false

    if (notReadyRef.current) return false

    if (!isController) {
      if (video.paused && syncState?.playing) {
        requestPlay()
        return true
      }
      refuseControl()
      return false
    }

    resumeAtMsRef.current = null
    if (video.paused) {
      requestPlay()
      return true
    }
    playRequestedRef.current = false
    video.pause()
    send('pause', { positionMs: commandPositionMs(video), rate: video.playbackRate })
    return true
  }, [commandPositionMs, isController, refuseControl, requestPlay, send, syncState, videoRef])

  const reportNativeToggle = useCallback((playing: boolean) => {
    if (!isController || coldWait) return
    const sync = syncRef.current
    if (!sync || sync.playing === playing) return
    if (Date.now() - (remoteSteerAtRef?.current ?? 0) < REMOTE_ECHO_MS) return
    const video = videoRef.current
    if (!video) return
    if (!playing) playRequestedRef.current = false
    send(playing ? 'play' : 'pause', { positionMs: commandPositionMs(video), rate: video.playbackRate })
  }, [coldWait, commandPositionMs, isController, remoteSteerAtRef, send, videoRef])

  const reportEnded = useCallback(() => {
    if (!isController) return
    const video = videoRef.current
    const sync = syncRef.current
    if (!video || !sync?.playing) return
    const end = room.durationMs && room.durationMs > 0
      ? room.durationMs
      : Math.round((video.duration + loadedOffsetSecRef.current) * 1000)
    const expected = expectedPositionMs(sync, Date.now() + serverOffsetRef.current)
    if (room.durationMs && expected < room.durationMs - REGION_BEHIND_MS * 5) return
    playRequestedRef.current = false
    send('pause', { positionMs: end, rate: video.playbackRate })
  }, [isController, room.durationMs, send, videoRef])

  const pendingSentServerMs = useRef(0)
  const seek = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    if (seekBusyRef.current) {
      toast(t('room.seekBusy'))
      return
    }
    pendingSentServerMs.current = Date.now() + serverOffsetMs
    setPendingSeekSec(seconds)
    send('seek', { positionMs: Math.round(seconds * 1000) })
    resumeAtMsRef.current = null
    if (syncState?.playing) {
      resumeAtMsRef.current = Math.round(seconds * 1000)
      playRequestedRef.current = false
      send('pause', { positionMs: Math.round(seconds * 1000), rate: video.playbackRate })
    }
  }, [duration, isController, mediaOffsetSec, regions, send, serverOffsetMs, syncState, t, toast, videoRef])
  if (seekRef) seekRef.current = seek

  useEffect(() => {
    if (syncState?.playing) resumeAtMsRef.current = null
  }, [syncState?.playing])
  useEffect(() => {
    if (syncState && !syncState.playing) {
      playRequestedRef.current = false
      setNeedsGesture(false)
    }
  }, [syncState])

  useEffect(() => {
    if (autoplayBlocked) setNeedsGesture(true)
  }, [autoplayBlocked])

  useEffect(() => {
    if (coldWait) return
    if (pendingSeekSec !== null && Math.abs(currentTime - pendingSeekSec) < 3) setPendingSeekSec(null)
  }, [coldWait, currentTime, pendingSeekSec])

  useEffect(() => {
    if (pendingSeekSec === null || !syncState) return
    if (syncState.serverTimeMs < pendingSentServerMs.current - 500) return
    const expected = expectedPositionMs(syncState, Date.now() + serverOffsetMs)
    if (Math.abs(expected - pendingSeekSec * 1000) > 15_000) setPendingSeekSec(null)
  }, [pendingSeekSec, serverOffsetMs, syncState])

  const goLive = useCallback(() => {
    const video = videoRef.current
    if (!video || !syncState) return
    const expected = expectedPositionMs(syncState, Date.now() + serverOffsetMs)
    if (Math.abs(video.currentTime * 1000 + mediaOffsetMs - expected) <= LIVE_SYNC_THRESHOLD_MS) return
    video.currentTime = (expected - mediaOffsetMs) / 1000
  }, [mediaOffsetMs, serverOffsetMs, syncState, videoRef])

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return false
    if (!isController) {
      refuseControl()
      return false
    }
    const ceiling = timelineEnd > 0 ? timelineEnd : Number.POSITIVE_INFINITY
    seek(Math.min(Math.max(video.currentTime + mediaOffsetSec + delta, 0), ceiling))
    return true
  }, [timelineEnd, mediaOffsetSec, isController, refuseControl, seek, videoRef])

  const applyVolume = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    const next = Math.min(Math.max(value, 0), 1)
    video.volume = next
    if (next > 0 && video.muted) video.muted = false
  }, [videoRef])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    return video.muted
  }, [videoRef])

  const volumeRef = useRef<HTMLDivElement>(null)
  const volumePanelRef = useRef<HTMLDivElement>(null)
  const chaseRef = useRef<(() => void) | null>(null)
  const draggingRef = useRef(false)
  const endChase = useCallback(() => {
    chaseRef.current?.()
    chaseRef.current = null
  }, [])
  useEffect(() => endChase, [endChase])

  const openVolume = useCallback(() => {
    endChase()
    setVolumeOpen(true)
  }, [endChase])

  const holdVolume = useCallback(() => {
    if (draggingRef.current) return
    draggingRef.current = true
    endChase()
    const release = (up: PointerEvent) => {
      draggingRef.current = false
      document.removeEventListener('pointerup', release)
      document.removeEventListener('pointercancel', release)
      const at = { x: up.clientX, y: up.clientY }
      const over = (el: HTMLElement | null) => el !== null && inBox(at, el.getBoundingClientRect())
      if (!over(volumeRef.current) && !over(volumePanelRef.current)) setVolumeOpen(false)
    }
    document.addEventListener('pointerup', release)
    document.addEventListener('pointercancel', release)
  }, [endChase])

  const chaseVolume = useCallback((event: React.PointerEvent) => {
    if (draggingRef.current) return
    endChase()
    const panel = volumePanelRef.current
    if (!panel || event.pointerType !== 'mouse') {
      setVolumeOpen(false)
      return
    }
    const from = { x: event.clientX, y: event.clientY }
    const box = panel.getBoundingClientRect()
    const stop = () => {
      document.removeEventListener('pointermove', onMove)
      window.clearTimeout(timer)
    }
    const onMove = (move: PointerEvent) => {
      if (draggingRef.current) return
      if (heading({ x: move.clientX, y: move.clientY }, from, box)) return
      stop()
      chaseRef.current = null
      setVolumeOpen(false)
    }
    const timer = window.setTimeout(() => {
      stop()
      chaseRef.current = null
      setVolumeOpen(false)
    }, VOLUME_CHASE_MS)
    chaseRef.current = stop
    document.addEventListener('pointermove', onMove)
  }, [endChase])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    const request = playerRef.current?.requestFullscreen?.()
    void request?.catch(() => undefined)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (focusOwnsKey(event.target, event.key)) return

      const video = videoRef.current
      const handled = () => {
        event.preventDefault()
        revealControls(true)
      }

      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          handled()
          if (togglePlay()) showFeedback(video?.paused ? <Play size={26} /> : <Pause size={26} />)
          return
        case 'ArrowLeft':
        case 'ArrowRight': {
          handled()
          const delta = event.key === 'ArrowLeft' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
          showFeedback(seekBy(delta) ? seekFeedback(delta) : <Lock size={24} />)
          return
        }
        case 'j':
        case 'J':
        case 'l':
        case 'L': {
          handled()
          const delta = event.key.toLowerCase() === 'j' ? -SEEK_STEP_LARGE_SECONDS : SEEK_STEP_LARGE_SECONDS
          showFeedback(seekBy(delta) ? seekFeedback(delta) : <Lock size={24} />)
          return
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          handled()
          const delta = event.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP
          const base = video?.muted ? 0 : video?.volume ?? 0
          applyVolume(base + delta)
          showFeedback(
            <>{volumeIcon(Math.min(Math.max(base + delta, 0), 1), 24)}{Math.round(Math.min(Math.max(base + delta, 0), 1) * 100)}%</>,
          )
          return
        }
        case 'm':
        case 'M':
          handled()
          showFeedback(toggleMute() ? <VolumeX size={26} /> : <Volume2 size={26} />)
          return
        case 'f':
        case 'F':
          handled()
          toggleFullscreen()
          return
        case 'Home':
        case 'End': {
          handled()
          const target = event.key === 'Home' ? 0 : Math.max(timelineEnd - 1, 0)
          if (isController) {
            seek(target)
            showFeedback(event.key === 'Home' ? <SkipBack size={26} /> : <SkipForward size={26} />)
          } else showFeedback(<Lock size={24} />)
          return
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [applyVolume, timelineEnd, isController, revealControls, seek, seekBy, showFeedback, toggleFullscreen, toggleMute, togglePlay, videoRef])

  const muteLabel = t(muted || volume === 0 ? 'room.unmute' : 'room.mute')
  const fullscreenLabel = t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')
  const playLabel = t(playing ? 'room.pause' : 'room.play')

  const settingGroups: SettingGroup[] = useMemo(() => {
    const groups: SettingGroup[] = []
    if (room.mediaBaseUrl && subtitleTracks.length > 0) {
      groups.push({
        id: 'subtitles',
        label: t('room.subtitles'),
        current: subtitle,
        onPick: setSubtitle,
        options: [
          { value: -1, label: t('room.off') },
          ...subtitleTracks.map((track) => ({
            value: track.index,
            label: track.title || track.language || String(track.index + 1),
          })),
        ],
      })
    }
    if (audioTracks.length > 1) {
      groups.push({
        id: 'audio',
        label: t('room.audio'),
        current: audioTrack,
        onPick: (value) => {
          setAudioTrack(value)
          if (hlsRef.current) hlsRef.current.audioTrack = value
        },
        options: audioTracks.map((track, index) => ({
          value: index,
          label: audioTrackLabel(track, t.language, index),
        })),
      })
    }
    if (levels.length > 1) {
      groups.push({
        id: 'quality',
        label: t('room.quality'),
        current: level,
        onPick: (value) => {
          setLevel(value)
          if (hlsRef.current) hlsRef.current.currentLevel = value
        },
        options: [
          { value: -1, label: t('room.qualityAuto') },
          ...levels.map((entry, index) => ({
            value: index,
            label: entry.height ? `${entry.height}p` : `${Math.round(entry.bitrate / 1000)} kbps`,
          })),
        ],
      })
    }
    return groups
  }, [room.mediaBaseUrl, subtitleTracks, subtitle, audioTracks, audioTrack, levels, level, t])

  const seekMax = Math.max(timelineEnd, 1)
  const pct = (seconds: number) => `${(Math.min(Math.max(seconds, 0), seekMax) / seekMax) * 100}%`
  const chapters = useMemo(() => (room.chapters ?? [])
    .map((chapter, index) => ({ ...chapter, ordinal: index + 1 }))
    .filter((chapter) => chapter.startMs / 1000 < seekMax), [room.chapters, seekMax])
  const chapterLabel = useCallback((index: number) =>
    chapters[index].title || `${t('player.chapter')} ${chapters[index].ordinal}`, [chapters, t])
  const chapterIndexAt = useCallback((seconds: number) =>
    chapters.findIndex((chapter) => seconds * 1000 >= chapter.startMs && seconds * 1000 < chapter.endMs), [chapters])
  const currentChapterIndex = chapterIndexAt(currentTime)
  const [seekHover, setSeekHover] = useState<{ leftPct: number; text: string } | null>(null)
  const hoverRectRef = useRef<DOMRect | null>(null)
  const [behindBands, aheadBands] = useMemo(() => {
    const behind: Array<{ from: number; to: number }> = []
    const ahead: Array<{ from: number; to: number }> = []
    for (const range of bufferedRanges) {
      const start = Math.min(Math.max(range.start, 0), seekMax)
      const end = Math.min(Math.max(range.end, 0), seekMax)
      if (start < Math.min(currentTime, end)) behind.push({ from: start, to: Math.min(currentTime, end) })
      if (end > Math.max(start, currentTime)) ahead.push({ from: Math.max(start, currentTime), to: end })
    }
    return [behind, ahead]
  }, [bufferedRanges, currentTime, seekMax])
  const bufferAheadSec = useMemo(
    () => bufferAhead(bufferedRanges, currentTime),
    [bufferedRanges, currentTime],
  )
  const gateSec = gateSecondsFor({
    producedEdgeSec: activeRegion?.growing ? activeRegion.producedMs / 1000 : null,
    currentTime,
    sealed: activeRegion !== null && !activeRegion.growing,
    gatedStart,
    opening: !opened,
  })
  const bufferGate = !coldWait && holdsForBuffer({
    aheadSec: bufferAheadSec,
    gateSec,
    currentTime,
    timelineEnd,
    playing,
    ready: duration > 0,
  })
  const bufferGateRef = useRef(bufferGate)
  bufferGateRef.current = bufferGate
  const waitLeft = bufferGate && !coldWait ? Math.max(Math.ceil(gateSec - bufferAheadSec), 1) : null
  const onWaitRef = useRef(onWait)
  onWaitRef.current = onWait
  useEffect(() => {
    if (!(duration > 0)) return
    onWaitRef.current?.({ secondsLeft: bufferGate ? waitLeft : null, cold: coldWait })
    if (!bufferGate && !coldWait) setOpened(true)
  }, [bufferGate, coldWait, duration, waitLeft])
  useEffect(() => {
    const at = resumeAtMsRef.current
    if (at === null) return
    if (coldWait || bufferGate || !(duration > 0)) return
    if (regions && !regions.some((r) => regionHolds(r, at))) return
    resumeAtMsRef.current = null
    send('play', { positionMs: at, rate: videoRef.current?.playbackRate ?? 1 })
  }, [bufferGate, coldWait, duration, regions, room.mediaVersion, send, videoRef])
  useEffect(() => {
    if (bufferGate) return
    if (viewerTrace.open()) {
      viewerTrace.mark('gateOpen', Math.round(gateSec * 10) / 10)
      viewerTrace.end()
    }
    attemptPlay()
  }, [bufferGate, attemptPlay])

  const [stalledLong, setStalledLong] = useState(false)
  useEffect(() => {
    if (!loading) {
      setStalledLong(false)
      return
    }
    const timer = window.setTimeout(() => setStalledLong(true), 3_000)
    return () => window.clearTimeout(timer)
  }, [loading])
  const seekBusy = coldWait || pendingSeekSec !== null
  seekBusyRef.current = seekBusy
  const controlsBlocked = seekBusy || stalledLong
  notReadyRef.current = controlsBlocked

  const expectedMs = !isController && syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : null
  const atLiveEdge = expectedMs === null || Math.abs(currentTime * 1000 - expectedMs) <= LIVE_SYNC_THRESHOLD_MS

  const controlsShown = !playing || controlsVisible
  const inControlStrip = (event: { target: EventTarget | null; clientY: number }): boolean => {
    if ((event.target as HTMLElement | null)?.closest('.player-controls')) return true
    if (!controlsShown) return false
    const strip = controlsRef.current?.getBoundingClientRect()
    return strip !== undefined && strip.height > 0 && event.clientY >= strip.top
  }

  return (
    <div
      ref={playerRef}
      className={`player-wrap ${playing && !controlsVisible ? 'controls-hidden' : ''}`}
      onPointerMove={() => revealControls(playing)}
      onPointerDown={() => revealControls(playing)}
      onFocusCapture={() => revealControls(false)}
      onBlurCapture={() => revealControls(playing)}
      onClick={(event) => {
        if (inControlStrip(event)) return
        cancelPendingTap()
        tapTimerRef.current = setTimeout(() => {
          tapTimerRef.current = null
          if (togglePlay()) {
            showFeedback(videoRef.current?.paused ? <Play size={26} /> : <Pause size={26} />)
          }
        }, TAP_TOGGLE_DELAY_MS)
      }}
      onDoubleClick={(event) => {
        if (inControlStrip(event)) return
        cancelPendingTap()
        toggleFullscreen()
      }}
    >
      {needsGesture && !coldWait ? (
        <button
          type="button"
          className="player-gesture"
          onClick={() => { setNeedsGesture(false); requestPlay() }}
        >
          <Play size={26} />
          <span>{t('room.tapToJoin')}</span>
        </button>
      ) : null}
      {loading || coldWait || bufferGate ? (
        <div className="player-loading" role="status" aria-live="polite">
          <span className="player-spinner" aria-hidden="true" />
          {stalledLong || coldWait || bufferGate ? (
            <div className="player-preparing">
              <WaitLabel secondsLeft={waitLeft} t={t} />
              {swarm ? <TorrentReadout stats={swarm} /> : null}
            </div>
          ) : null}
          <span className="sr-only">{t('status.buffering')}</span>
        </div>
      ) : null}
      <video
        ref={videoRef}
        className="video"
        playsInline
        crossOrigin="anonymous"
        onPlay={() => {
          setPlaying(true)
          reportNativeToggle(true)
        }}
        onPause={() => {
          setPlaying(false)
          reportNativeToggle(false)
        }}
        onWaiting={() => { setLoading(true); onBuffering?.(true) }}
        onStalled={() => { setLoading(true); onBuffering?.(true) }}
        onSeeking={() => setLoading(true)}
        onPlaying={() => { setLoading(false); onBuffering?.(false) }}
        onSeeked={() => setLoading(false)}
        onEnded={() => reportEnded()}
        onLoadedData={() => catchUp()}
        onCanPlay={() => {
          setLoading(false)
          onBuffering?.(false)
          const media = videoRef.current
          if (resumeAfterReloadRef.current && !coldWait && media?.paused) {
            resumeAfterReloadRef.current = false
            void media.play().catch(() => undefined)
          }
          attemptPlay()
          catchUp()
        }}
        onTimeUpdate={(event) => {
          const loadedOffset = loadedOffsetSecRef.current
          const absoluteSec = event.currentTarget.currentTime + loadedOffset
          setCurrentTime(absoluteSec)
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(keepRanges(shiftRanges(readBufferedRanges(event.currentTarget), loadedOffset)))
          if (regions && loadedOffset === mediaOffsetSec) {
            const next = regionFor(regions, absoluteSec * 1000, activeRegionN)
            if (next !== null && next !== activeRegionN) setActiveRegionN(next)
          }
        }}
        onDurationChange={(event) => setDuration(playableDuration(event.currentTarget))}
        onLoadedMetadata={(event) => setDuration(playableDuration(event.currentTarget))}
        onProgress={(event) => {
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(keepRanges(shiftRanges(readBufferedRanges(event.currentTarget), mediaOffsetSec)))
        }}
      >
        {(room.mediaBaseUrl ? (room.subtitleTracks ?? []) : []).map((track) => (
          <track
            key={`${track.index}-${track.language}-${room.mediaGeneration}-${mediaReload}-${mediaOffsetMs}-${track.digest ?? room.subsVersion ?? 0}`}
            kind="subtitles"
            onLoad={(event) => shiftTrackCues(event.currentTarget.track, mediaOffsetSec)}
            src={subtitleSource(room, track)}
            srcLang={track.language || 'und'}
            label={track.title || track.language || `Subtitle ${track.index + 1}`}
          />
        ))}
      </video>
      <SubtitleLayer
        videoRef={videoRef}
        position={assChosen && !assFailed ? -1 : subtitleTracks.findIndex((track) => track.index === subtitle)}
        revision={`${room.mediaGeneration}-${mediaReload}-${room.subsVersion ?? 0}-${subtitleCount}`}
      />
      {assChosen && chosenSubtitleTrack ? (
        <AssLayer
          key={`ass-${chosenSubtitleTrack.index}-${room.mediaGeneration}`}
          videoRef={videoRef}
          subUrl={assSource(room, chosenSubtitleTrack)}
          fontUrls={assFontUrls}
          timeOffsetSec={mediaOffsetSec}
          onFailed={setAssFailed}
        />
      ) : null}
      {feedback ? <span key={feedback.id} className="player-feedback" aria-hidden="true">{feedback.node}</span> : null}
      {unplayable ? (
        <div className="player-unplayable" role="alert">
          <p>{t(unplayable.cause === 'codec' ? 'room.unplayable' : 'room.playbackFailed')}</p>
          <CopyErrorReport room={room} failure={`playback: ${unplayable.reason}`} detail={lastUploadFailureDetail()} t={t} />
        </div>
      ) : null}
      <div className="player-controls" ref={controlsRef}>
        <div
          className="seek-control"
          onPointerEnter={(event) => { hoverRectRef.current = event.currentTarget.getBoundingClientRect() }}
          onPointerMove={(event) => {
            if (event.pointerType === 'touch') return
            const rect = hoverRectRef.current ?? event.currentTarget.getBoundingClientRect()
            hoverRectRef.current = rect
            if (rect.width <= 0) return
            const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
            const seconds = frac * seekMax
            const index = chapterIndexAt(seconds)
            const text = index >= 0
              ? `${chapterLabel(index)} · ${formatTime(seconds)}`
              : formatTime(seconds)
            const leftPct = Math.min(Math.max(frac * 100, 6), 94)
            setSeekHover((prev) => (
              prev && prev.text === text && Math.abs(prev.leftPct - leftPct) < 0.25 ? prev : { leftPct, text }
            ))
          }}
          onPointerLeave={() => { hoverRectRef.current = null; setSeekHover(null) }}
          onPointerCancel={() => { hoverRectRef.current = null; setSeekHover(null) }}
        >
          <div className="seek-track" aria-hidden="true">
            <div className="seek-played" style={{ width: pct(scrubSec ?? pendingSeekSec ?? shownSec) }} />
            {behindBands.map((band) => (
              <div
                key={`b${band.from}`}
                className="seek-behind"
                style={{ left: pct(band.from), width: `${((band.to - band.from) / seekMax) * 100}%` }}
              />
            ))}
            {aheadBands.map((band) => (
              <div
                key={`a${band.from}`}
                className="seek-ahead"
                style={{ left: pct(band.from), width: `${((band.to - band.from) / seekMax) * 100}%` }}
              />
            ))}
            {chapters.filter((chapter) => chapter.startMs > 0).map((chapter) => (
              <div
                key={`${chapter.ordinal}-${chapter.startMs}`}
                className="seek-chapter-tick"
                style={{ left: pct(chapter.startMs / 1000) }}
              />
            ))}
          </div>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={seekMax}
            value={Math.min(scrubSec ?? pendingSeekSec ?? shownSec, seekMax)}
            disabled={!isController || seekBusy}
            onPointerDown={() => { scrubbingRef.current = true }}
            onPointerUp={(event) => {
              if (scrubbingRef.current) {
                scrubbingRef.current = false
                seek(Number(event.currentTarget.value))
                setScrubSec(null)
              }
              event.currentTarget.blur()
            }}
            onPointerCancel={() => {
              scrubbingRef.current = false
              setScrubSec(null)
            }}
            onChange={(event) => {
              const seconds = Number(event.target.value)
              if (scrubbingRef.current) setScrubSec(seconds)
              else seek(seconds)
            }}
          />
          {seekHover ? (
            <span className="seek-tooltip" aria-hidden="true" style={{ left: `${seekHover.leftPct}%` }}>{seekHover.text}</span>
          ) : null}
        </div>
        <div className="controls-row">
          <button
            className="control-button is-play"
            aria-label={playLabel}
            title={`${playLabel} (Space)`}
            disabled={controlsBlocked}
            onClick={togglePlay}
            onPointerUp={(event) => event.currentTarget.blur()}
          >{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
          <span className="timecode">
            <NumberFlowGroup>
              <Timecode seconds={scrubSec ?? pendingSeekSec ?? shownSec} />
              <span className="timecode-slash">/</span>
              <Timecode seconds={timelineEnd} />
            </NumberFlowGroup>
            {currentChapterIndex >= 0 && onChapters ? (
              <button
                type="button"
                className="timecode-chapter"
                title={t('chapters.title')}
                onClick={onChapters}
              > · {chapterLabel(currentChapterIndex)}</button>
            ) : currentChapterIndex >= 0 ? (
              <span className="timecode-chapter"> · {chapterLabel(currentChapterIndex)}</span>
            ) : null}
          </span>
          {expectedMs !== null ? (
            <button
              className={`live-button ${atLiveEdge ? 'is-live' : ''}`}
              title={t(atLiveEdge ? 'room.liveInSync' : 'room.liveBehind')}
              onClick={goLive}
            >LIVE</button>
          ) : null}
          <span className="controls-gap" />
          <Settings groups={settingGroups} t={t} />
          <div
            ref={volumeRef}
            className={`volume-control ${volumeOpen ? 'is-open' : ''}`}
            onPointerEnter={openVolume}
            onPointerDown={holdVolume}
            onPointerLeave={chaseVolume}
          >
            <button
              className="control-button"
              aria-label={muteLabel}
              title={`${muteLabel} (M)`}
              onClick={toggleMute}
              onPointerUp={(event) => event.currentTarget.blur()}
            >{volumeIcon(muted ? 0 : volume, 16)}</button>
            <div className="volume-panel" ref={volumePanelRef}>
              <input
                className="volume-range"
                aria-label={t('room.volume')}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={muted ? 0 : volume}
                onChange={(event) => applyVolume(Number(event.target.value))}
              />
            </div>
          </div>
          <button
            className="control-button"
            aria-label={fullscreenLabel}
            title={`${fullscreenLabel} (F)`}
            onClick={toggleFullscreen}
          >{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
        </div>
      </div>
      {room.bitmapSubsSkipped > 0 ? <span className="notice-chip">{t('room.bitmapSkipped')}</span> : null}
      {overlay}
    </div>
  )
}

function focusOwnsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true

  const insidePlayer = target.closest('.player-wrap') !== null
  switch (target.tagName) {
    case 'INPUT':
      if ((target as HTMLInputElement).type !== 'range') return true
      return !insidePlayer || (isArrowKey(key) && !target.closest('.seek-control'))
    case 'SELECT':
    case 'OPTION':
      return !insidePlayer || isArrowKey(key) || key === ' '
    case 'BUTTON':
    case 'A':
      return !insidePlayer
    default:
      return false
  }
}

function isArrowKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
}

function seekFeedback(delta: number): ReactNode {
  return (
    <>
      {delta > 0 ? <FastForward size={24} /> : <Rewind size={24} />}
      {delta > 0 ? `+${delta}s` : `${delta}s`}
    </>
  )
}

function volumeIcon(value: number, size: number): ReactNode {
  if (value === 0) return <VolumeX size={size} />
  return value < 0.5 ? <Volume1 size={size} /> : <Volume2 size={size} />
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function readBufferedRanges(video: HTMLVideoElement): BufferedRange[] {
  const ranges: BufferedRange[] = []
  for (let index = 0; index < video.buffered.length; index += 1) {
    ranges.push({ start: video.buffered.start(index), end: video.buffered.end(index) })
  }
  return ranges
}

function keepRanges(next: BufferedRange[]): (prev: BufferedRange[]) => BufferedRange[] {
  return (prev) => (
    prev.length === next.length && prev.every((range, index) => range.start === next[index].start && range.end === next[index].end)
      ? prev
      : next
  )
}

function shiftRanges(ranges: BufferedRange[], offsetSec: number): BufferedRange[] {
  if (offsetSec === 0) return ranges
  return ranges.map((range) => ({ start: range.start + offsetSec, end: range.end + offsetSec }))
}

function shiftTrackCues(track: TextTrack | undefined, offsetSec: number): void {
  if (!track || offsetSec === 0 || !track.cues) return
  const cues = [...track.cues] as VTTCue[]
  for (const cue of cues) {
    const end = cue.endTime - offsetSec
    if (end <= 0) {
      track.removeCue(cue)
      continue
    }
    cue.startTime = Math.max(cue.startTime - offsetSec, 0)
    cue.endTime = end
  }
}

function playableDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  if (video.seekable.length > 0) return video.seekable.end(video.seekable.length - 1)
  if (video.buffered.length > 0) return video.buffered.end(video.buffered.length - 1)
  return 0
}

function safeLanguage(language: string): string {
  return language && language.length <= 35 && /^[A-Za-z0-9_-]+$/.test(language) ? language : 'und'
}

type HlsModule = typeof import('hls.js')

function plog(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  console[level]('[ss-player]', ...parts)
}

function codecStrippingLoader(Base: HlsModule['default']['DefaultConfig']['loader']): HlsConfig['pLoader'] {
  return class extends Base {
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      if (context.type === 'manifest') {
        const onSuccess = callbacks.onSuccess
        callbacks.onSuccess = (response, stats, loadedContext, networkDetails) => {
          if (typeof response.data === 'string') {
            response.data = response.data
              .replace(/CODECS="[^"]*",/g, '')
              .replace(/,?CODECS="[^"]*"/g, '')
          }
          onSuccess(response, stats, loadedContext, networkDetails)
        }
      }
      super.load(context, config, callbacks)
    }
  } as HlsConfig['pLoader']
}
