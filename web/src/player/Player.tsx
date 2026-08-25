import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  FastForward, Lock, Maximize, Minimize, Pause, Play, Rewind,
  SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from 'lucide-react'
import type Hls from 'hls.js'
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import type { MediaRegion, PlayState, RoomInfo } from '../types'
import type { Translator } from '../i18n/useT'
import { audioTrackLabel } from './audioTracks'
import { expectedPositionMs } from './position'
import { Settings, type SettingGroup } from './Settings'
import { SubtitleLayer } from './SubtitleLayer'
import { MOCK_AUDIO_TRACKS, MOCK_LEVELS, mocksEnabled } from '../mocks'
import { TorrentReadout } from '../components/TorrentReadout'
import type { TorrentStats } from '../torrent'
import { useToast } from '../ui/toastContext'

interface PlayerProps {
  room: RoomInfo
  isController: boolean
  videoRef: MutableRefObject<HTMLVideoElement | null>
  send: (type: string, payload?: Record<string, unknown>) => void
  t: Translator
  // The shared playback state and clock offset, for the viewer LIVE control.
  syncState?: PlayState
  serverOffsetMs?: number
  // The swarm feeding this room's source, when this tab is the host: shown
  // while playback is stuck waiting for a part that is still downloading.
  swarm?: TorrentStats | null
  // Extra content rendered inside the fullscreen-capable wrap.
  overlay?: ReactNode
  // Opens the room's chapter list, when the room has one to show.
  onChapters?: () => void
  // Where the sync layer reads this player's current offset: the region the
  // element holds is the player's choice, and the clock has to follow it.
  mediaOffsetMsRef?: MutableRefObject<number>
}

// How far past a growing region's produced edge a position still counts as
// its: the pipeline is on its way there. Mirrors the pipeline's own margin.
const REGION_AHEAD_MS = 30_000
const REGION_BEHIND_MS = 1_000

function regionHolds(region: MediaRegion, ms: number): boolean {
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

// TAP_TOGGLE_DELAY_MS is how long a tap waits to see whether it is really the
// first half of a double click. Long enough for a deliberate double click,
// short enough that pausing still feels like it happened on contact.
const TAP_TOGGLE_DELAY_MS = 200

const SEEK_STEP_SECONDS = 5
const SEEK_STEP_LARGE_SECONDS = 10
const VOLUME_STEP = 0.05
// Long enough to read the symbol, short enough that holding an arrow key still
// feels like scrubbing rather than a stack of notifications.
const FEEDBACK_MS = 700
// A media error can be a corrupt append worth retrying, but only a couple of
// times. Past that the retry is the bug, not the fix.
const MAX_MEDIA_RECOVERIES = 2
const FRAME_WATCH_INTERVAL_MS = 1000
const MANIFEST_RETRY_MS = 2000
// Seconds the clock may advance without a single new displayed video frame
// before the player declares the video dead. Even a slideshow-style encode
// composites a frame well inside this budget.
const VIDEO_STARVATION_SECONDS = 5
// Drift past this reads as out of sync on the LIVE control. Wider than the
// auto-resync threshold, so it only lights up for drift that resyncing is
// not already absorbing — a stalled or long-buffering viewer.
const LIVE_SYNC_THRESHOLD_MS = 1000

interface BufferedRange {
  start: number
  end: number
}

// subtitleSource points a track at the bucket the subtitle files live in. The
// version query string stays: the file keeps its name as more cues are
// extracted, so only a changed URL makes the browser refetch it.
//
// Without a base there is nowhere to point: this server no longer serves
// subtitle files. The caller renders no tracks at all rather than offering
// ones that cannot load.
// index is the track's own position in the source, not its place in the menu.
// A progressive extraction announces only the tracks that already hold a cue,
// so the list arrives with gaps — a forced track has nothing in it until the
// first foreign sign appears — while each published file keeps the name of the
// track it came from.
function subtitleSource(room: RoomInfo, index: number, language: string): string {
  const version = `?g=${room.mediaGeneration}&s=${room.subsVersion ?? 0}`
  return `${room.mediaBaseUrl}/subs/sub_${index}_${safeLanguage(language)}.vtt${version}`
}

export function Player({ room, isController, videoRef, send, t, syncState, serverOffsetMs = 0, swarm, overlay, onChapters, mediaOffsetMsRef }: PlayerProps) {
  const { toast } = useToast()
  // Says why a control did nothing, at the moment it is used. The standing
  // note this replaces sat in the bar for the whole session, explaining
  // something nobody had tried yet.
  const refuseControl = useCallback(() => toast(t('room.controllerOnly')), [t, toast])
  const playerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  // The live sync state, readable from effects without re-running them.
  const syncRef = useRef<PlayState | undefined>(syncState)
  syncRef.current = syncState
  const serverOffsetRef = useRef(serverOffsetMs)
  serverOffsetRef.current = serverOffsetMs
  // The offset of the source the element actually holds. The state-derived
  // offset moves a render before the element reloads; anything comparing it
  // with the element's own clock must use this one instead.
  const loadedOffsetSecRef = useRef(0)
  const playRequestedRef = useRef(false)
  const playAttemptRef = useRef(false)
  const controlsTimerRef = useRef<number | null>(null)
  const feedbackSeqRef = useRef(0)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>(
    () => (mocksEnabled ? MOCK_AUDIO_TRACKS : []),
  )
  // The picture sizes this source was published in, and which one this viewer
  // is watching. -1 is hls.js's "pick for me". The choice is deliberately per
  // person: everyone in a room has a different connection, and picking a
  // quality for the group would just move the stalling to whoever has least.
  // Seeded from the mock only in a dev mock build, where hls.js never attaches
  // to a playlist and would otherwise report none of either.
  const [levels, setLevels] = useState<Array<{ height: number; bitrate: number }>>(
    () => (mocksEnabled ? MOCK_LEVELS : []),
  )
  const [level, setLevel] = useState(-1)
  const [subtitle, setSubtitle] = useState(-1)
  // Mirrors what hls.js is decoding, so the settings can name the dub in use.
  const [audioTrack, setAudioTrack] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // The scrubber's value while a drag is in flight, and the committed target
  // while the room is still travelling there. Without them the controlled
  // input snaps back to currentTime on every render, and the native change
  // event that closes the gesture fires with that restored value — a second
  // seek to where the room already was, overwriting the real one.
  const [scrubSec, setScrubSec] = useState<number | null>(null)
  const [pendingSeekSec, setPendingSeekSec] = useState<number | null>(null)
  const scrubbingRef = useRef(false)
  // Every position the room speaks is absolute; the media element only ever
  // holds one region, rebased to zero. With a region map the player picks
  // the region for the time the room is at; a room without one (older, or
  // before the first publish) has only the offset the room names. Either
  // way: element time + offset = room time.
  const regions = room.mediaRegions && room.mediaRegions.length > 0 ? room.mediaRegions : null
  // Initialised to the region the room is already at, so the first load
  // opens the right playlists instead of loading the bare master and
  // immediately tearing it down for the region's own.
  const [activeRegionN, setActiveRegionN] = useState<number | null>(() => {
    if (!room.mediaRegions || room.mediaRegions.length === 0) return null
    const wantedMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : 0
    return regionFor(room.mediaRegions, wantedMs, null)
  })
  const activeRegion = regions?.find((r) => r.n === activeRegionN) ?? null
  const mediaOffsetMs = activeRegion ? activeRegion.startMs : (room.mediaOffsetMs ?? 0)
  const mediaOffsetSec = mediaOffsetMs / 1000
  if (mediaOffsetMsRef) mediaOffsetMsRef.current = mediaOffsetMs
  const masterName = activeRegion ? `r${activeRegion.n}_master.m3u8` : 'master.m3u8'
  // Re-decided whenever the map or the room's clock moves. A change here is
  // what reloads the player onto another region's playlists.
  useEffect(() => {
    if (!regions) { setActiveRegionN(null); return }
    const video = videoRef.current
    const wantedMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs)
      : video ? video.currentTime * 1000 + mediaOffsetMs : 0
    const next = regionFor(regions, wantedMs, activeRegionN)
    if (next !== null && next !== activeRegionN) setActiveRegionN(next)
  }, [regions, syncState, serverOffsetMs, activeRegionN, mediaOffsetMs, videoRef])
  // The timeline is the room's, not the element's: the scrubber promises the
  // whole episode from the first publish, while the element grows region by
  // region behind it.
  const timelineEnd = room.durationMs ? room.durationMs / 1000 : duration + mediaOffsetSec
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([])
  const [playing, setPlaying] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [feedback, setFeedback] = useState<{ id: number; node: ReactNode } | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  const recoveriesRef = useRef(0)
  const resumeRef = useRef({ generation: -1, time: 0 })

  const revealControls = useCallback((autoHide = true) => {
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    setControlsVisible(true)
    if (!autoHide) return
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false)
    }, 2500)
  }, [])

  // A keyboard action gets the same acknowledgement a click gets from the
  // control moving: a symbol in the middle of the frame, since the pointer is
  // nowhere near the controls and they may be hidden entirely.
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
    if (playing) revealControls()
    else revealControls(false)
    return () => {
      if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    }
  }, [playing, revealControls])

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  // Volume lives on the element, so mirror the element rather than trying to
  // own the value: it also changes from the OS, from the range input and from
  // keyboard shortcuts.
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
    // The URL is stable across a source swap, so the generation is what tells
    // the browser, hls.js and any proxy that this is different media. The
    // version moves when the same media is republished behind the URL — the
    // final remux replacing the progressive preview — and reloading then is
    // what hands a preview viewer the finished playlists.
    const source = `/media/${encodeURIComponent(room.id)}/hls/${masterName}?g=${generation}&v=${room.mediaVersion ?? 0}`
    let disposed = false
    setUnplayable(false)
    recoveriesRef.current = 0
    // A republish of the same recording resumes where this player was; only
    // a different recording starts over from its beginning. When the room's
    // clock is known it wins: a region switch rebuilds the player exactly
    // because the room moved somewhere the old region did not hold, and
    // resuming at the old position would open the new region in the wrong
    // place.
    const sync = syncRef.current
    const resumeAbs = resumeRef.current.generation === generation ? resumeRef.current.time : 0
    const wantedAbs = sync ? expectedPositionMs(sync, Date.now() + serverOffsetRef.current) / 1000 : resumeAbs
    const startPosition = Math.max(wantedAbs - mediaOffsetSec, 0)
    loadedOffsetSecRef.current = mediaOffsetSec

    const failPlayback = (reason: string) => {
      if (disposed) return
      plog('error', `giving up: ${reason}`)
      hlsRef.current?.destroy()
      hlsRef.current = null
      setLevels([])
      setLevel(-1)
      setUnplayable(true)
    }

    // The one observation that needs no error event: the clock moving while
    // the decoder produces nothing. Both known silent failures end up here —
    // hls.js dropping the video track and a hardware decoder dying mid-play —
    // so playback is judged by displayed frames, not only by which errors fire.
    let lastTime = video.currentTime
    let lastFrames = -1
    let starvedSeconds = 0
    const watchdog = window.setInterval(() => {
      if (typeof video.getVideoPlaybackQuality !== 'function') return
      // A seek can move the clock arbitrarily far in one tick; clamping keeps
      // a single jump from being mistaken for seconds of framelessness.
      const advanced = Math.min(Math.max(video.currentTime - lastTime, 0), FRAME_WATCH_INTERVAL_MS / 1000)
      lastTime = video.currentTime
      const frames = video.getVideoPlaybackQuality().totalVideoFrames
      if (frames !== lastFrames) {
        lastFrames = frames
        starvedSeconds = 0
        return
      }
      // A clock dragged forward by resync over an empty buffer is data
      // starvation, not a dead decoder: a cold seek waits there for its
      // region to arrive, and the watchdog must wait with it.
      if (video.paused || advanced <= 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      starvedSeconds += advanced
      if (starvedSeconds < VIDEO_STARVATION_SECONDS) return
      // A counter that has never moved is ambiguous: some platforms render
      // through an overlay and report zero throughout. Only an element with
      // no video dimensions proves nothing is attached. A counter that did
      // move and then froze is unambiguous on its own.
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
        failPlayback('this browser supports neither MediaSource HLS nor native HLS')
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
        // Progressive uploads are EVENT playlists. Native HLS commonly joins
        // those at the live edge and waits for the next uploaded segment;
        // hls.js lets an episode reliably start at its beginning instead.
        const config: Partial<HlsConfig> = { startPosition }
        if (stripCodecs) config.pLoader = codecStrippingLoader(HlsClass)
        const hls = new HlsClass(config)
        hlsRef.current = hls
        // MEDIA_ATTACHED fires again on every recoverMediaError re-attach, and
        // the recovery already resumes loading at the pre-error position by
        // itself. Reloading the source there would restart playback from the
        // configured start position — the flash to 0:00 viewers reported when
        // a seek outside the buffer stalled into a recovery.
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
        })
        // Fires when hls.js drops a level, e.g. after an undecodable codec.
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
            // hls.js reports a failed video SourceBuffer as non-fatal, drops
            // the track and keeps playing the audio group. When no remaining
            // rendition carries a different video codec, nothing will ever
            // render and staying quiet would mean sound over a black frame.
            if (data.details === ErrorDetails.BUFFER_ADD_CODEC_ERROR && data.sourceBufferName !== 'audio') {
              const failed = data.mimeType ?? ''
              const alternate = hls.levels.some((level) => level.videoCodec && !failed.includes(level.videoCodec))
              if (!alternate) failPlayback(`no decodable video rendition (${failed})`)
            }
            return
          }
          // A manifest-level rejection is a prediction made from the codec
          // string in the playlist, and a wrong string there would turn a
          // room that plays perfectly well into a dead end. Retry once with
          // the prediction stripped so the buffer gets to judge the actual
          // bytes; if the buffer also refuses, the room truly is unplayable.
          if (data.details === ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) {
            if (!stripCodecs) {
              plog('warn', 'every CODECS string was rejected; retrying without the prediction')
              hls.destroy()
              if (!disposed) buildPlayer(true)
              return
            }
            failPlayback('no compatible codecs in manifest')
            return
          }
          if (undecodable.has(data.details)) {
            failPlayback(`undecodable media (${data.details})`)
            return
          }
          if (data.type === ErrorTypes.NETWORK_ERROR) {
            // A 404 on the master playlist usually means the player mounted
            // before the host's first publish landed: the upload is fine, the
            // manifest just is not there yet. startLoad() cannot recover that
            // (there are no levels to restart), so the source itself is
            // reloaded on a leash until the publish catches up.
            if (data.details === ErrorDetails.MANIFEST_LOAD_ERROR || data.details === ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
              window.setTimeout(() => {
                if (!disposed && hlsRef.current === hls) hls.loadSource(source)
              }, MANIFEST_RETRY_MS)
              return
            }
            hls.startLoad()
            return
          }
          if (data.type === ErrorTypes.MEDIA_ERROR && recoveriesRef.current < MAX_MEDIA_RECOVERIES) {
            recoveriesRef.current += 1
            plog('warn', `attempting media error recovery ${recoveriesRef.current}/${MAX_MEDIA_RECOVERIES}`)
            hls.recoverMediaError()
            return
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
      resumeRef.current = { generation, time: video.currentTime + mediaOffsetSec }
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, room.mediaGeneration, room.mediaVersion, mediaOffsetSec, masterName, videoRef])

  // Subtitle modes are driven from state instead of the <select> handler so
  // the choice survives everything that reloads cues: a subsVersion bump
  // republishing the .vtt files under the same names (a growing extraction),
  // a media republish remounting hls.js, and any per-browser mode reset that
  // comes with a <track> src change. Only the first subtitleCount text tracks
  // belong to this component; hls.js may append its own after them.
  // The selection is remembered as the track's own index rather than its place
  // in the menu, because the menu grows: a progressive extraction announces a
  // track once it holds its first cue, and a forced track joining late lands
  // ahead of languages already listed. A remembered position would slide onto
  // one of them mid-episode.
  const subtitleTracks = room.subtitleTracks ?? []
  const subtitleCount = subtitleTracks.length
  useEffect(() => {
    const textTracks = videoRef.current?.textTracks
    if (!textTracks) return
    for (let position = 0; position < Math.min(textTracks.length, subtitleCount); position += 1) {
      // "hidden", never "showing": a hidden track still parses its file and
      // still reports which cues are active, but the browser does not draw it.
      // SubtitleLayer draws the chosen one, because Chrome renders a native
      // track in the operating system's caption style and ignores the page's
      // ::cue rules — the black slab and the clipped descenders come from there
      // and cannot be styled away.
      textTracks[position].mode = subtitle === -1 ? 'disabled' : 'hidden'
    }
  }, [subtitle, subtitleCount, subtitleTracks, room.subsVersion, room.mediaGeneration, room.mediaVersion, videoRef])

  const attemptPlay = useCallback(() => {
    const video = videoRef.current
    if (!video || !playRequestedRef.current || playAttemptRef.current) return
    playAttemptRef.current = true
    void video.play().then(() => {
      playAttemptRef.current = false
      if (!playRequestedRef.current) return
      playRequestedRef.current = false
      if (isController) {
        send('play', {
          positionMs: Math.round(video.currentTime * 1000) + mediaOffsetMs,
          rate: video.playbackRate,
        })
      }
    }).catch(() => {
      // A click can land while hls.js is still attaching the MediaSource.
      // Keep the intent and retry from the next canplay event.
      playAttemptRef.current = false
    })
  }, [isController, send, videoRef])

  // A double click fullscreens the player, and its first click is
  // indistinguishable from a single one until the second arrives. Acting
  // immediately would toggle twice and send a pause and a play over the sync
  // protocol, blinking playback for everyone in the room over a gesture that
  // was never about playback.
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingTap = useCallback(() => {
    if (tapTimerRef.current === null) return
    clearTimeout(tapTimerRef.current)
    tapTimerRef.current = null
  }, [])
  useEffect(() => cancelPendingTap, [cancelPendingTap])

  // Where a cold seek parked the room, waiting for its region to publish.
  const resumeAtMsRef = useRef<number | null>(null)

  // togglePlay reports whether it actually changed anything, so a refused
  // gesture does not flash feedback for something that did not happen.
  const togglePlay = useCallback((): boolean => {
    const video = videoRef.current
    if (!video) return false

    if (!isController) {
      // A viewer's gesture never changes what the room is doing. The one thing
      // it may do is start their own element when the room is already playing
      // and the browser refused to autoplay it — catching up, not controlling.
      // attemptPlay only reports a play upstream for the controller, so this
      // stays local while still inheriting the retry on canplay.
      if (video.paused && syncState?.playing) {
        playRequestedRef.current = true
        attemptPlay()
        return true
      }
      refuseControl()
      return false
    }

    resumeAtMsRef.current = null
    if (video.paused) {
      // Calling play inside the gesture preserves browser user activation. A
      // WebSocket round trip first would make browsers reject audible autoplay.
      playRequestedRef.current = true
      attemptPlay()
      return true
    }
    playRequestedRef.current = false
    video.pause()
    send('pause', {
      positionMs: Math.round(video.currentTime * 1000) + mediaOffsetMs,
      rate: video.playbackRate,
    })
    return true
  }, [attemptPlay, isController, refuseControl, send, syncState, videoRef])

  const pendingSentServerMs = useRef(0)
  const seek = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    pendingSentServerMs.current = Date.now() + serverOffsetMs
    setPendingSeekSec(seconds)
    send('seek', { positionMs: Math.round(seconds * 1000) })
    // A jump into media the pipeline has not produced yet parks the room at
    // the target: left running, the clock walks away while the region is
    // prepared and the video comes back minutes past where the viewer
    // pointed. The room resumes on its own when the new region publishes.
    const coveredEnd = mediaOffsetSec + (Number.isFinite(duration) ? duration : 0)
    const cold = regions
      ? !regions.some((r) => regionHolds(r, seconds * 1000))
      : duration > 0 && (seconds < mediaOffsetSec - 1 || seconds > coveredEnd + 5)
    resumeAtMsRef.current = null
    if (cold && syncState?.playing) {
      resumeAtMsRef.current = Math.round(seconds * 1000)
      send('pause', { positionMs: Math.round(seconds * 1000), rate: video.playbackRate })
    }
  }, [duration, isController, mediaOffsetSec, regions, send, serverOffsetMs, syncState, videoRef])

  // The parked room wakes up when the region it waited on arrives. A play or
  // pause anyone sends in the meantime takes the room over instead.
  const lastVersionRef = useRef(room.mediaVersion ?? 0)
  useEffect(() => {
    const version = room.mediaVersion ?? 0
    if (version === lastVersionRef.current) return
    lastVersionRef.current = version
    const at = resumeAtMsRef.current
    if (at === null) return
    resumeAtMsRef.current = null
    send('play', { positionMs: at, rate: videoRef.current?.playbackRate ?? 1 })
  }, [room.mediaVersion, send, videoRef])
  useEffect(() => {
    if (syncState?.playing) resumeAtMsRef.current = null
  }, [syncState?.playing])

  // The thumb holds the committed target until the video actually gets
  // there — on a cold seek that is however long the new region takes.
  useEffect(() => {
    if (pendingSeekSec !== null && Math.abs(currentTime - pendingSeekSec) < 3) setPendingSeekSec(null)
  }, [currentTime, pendingSeekSec])

  // Unless the room moves on without it: a state written after our seek
  // that sits somewhere else means another command won, and a thumb still
  // pinned to the lost target would disagree with the clock forever.
  useEffect(() => {
    if (pendingSeekSec === null || !syncState) return
    if (syncState.serverTimeMs < pendingSentServerMs.current - 500) return
    const expected = expectedPositionMs(syncState, Date.now() + serverOffsetMs)
    if (Math.abs(expected - pendingSeekSec * 1000) > 15_000) setPendingSeekSec(null)
  }, [pendingSeekSec, serverOffsetMs, syncState])

  // A viewer catching up moves only itself: never a room-wide command.
  const goLive = useCallback(() => {
    const video = videoRef.current
    if (!video || !syncState) return
    const expected = expectedPositionMs(syncState, Date.now() + serverOffsetMs)
    if (Math.abs(video.currentTime * 1000 + mediaOffsetMs - expected) <= LIVE_SYNC_THRESHOLD_MS) return
    video.currentTime = (expected - mediaOffsetMs) / 1000
  }, [mediaOffsetMs, serverOffsetMs, syncState, videoRef])

  // Relative seeking goes through the same synchronized command as the
  // scrubber, so the controller's own picture moves only once the server has
  // agreed on the position and everyone moves together.
  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return false
    if (!isController) {
      refuseControl()
      return false
    }
    // An unknown length must not become a zero ceiling: that would clamp
    // every rewind to a negative position, which the server rejects outright.
    const ceiling = timelineEnd > 0 ? timelineEnd : Number.POSITIVE_INFINITY
    seek(Math.min(Math.max(video.currentTime + mediaOffsetSec + delta, 0), ceiling))
    return true
  }, [timelineEnd, mediaOffsetSec, isController, refuseControl, seek, videoRef])

  const applyVolume = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    const next = Math.min(Math.max(value, 0), 1)
    video.volume = next
    // Raising the volume from a muted state is the obvious intent to hear it.
    if (next > 0 && video.muted) video.muted = false
  }, [videoRef])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    return video.muted
  }, [videoRef])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    const request = playerRef.current?.requestFullscreen?.()
    void request?.catch(() => undefined)
  }, [])

  // Shortcuts are bound on the document so they work without first clicking
  // the video, which is the whole point of a keyboard shortcut. Anything typed
  // into a field, or aimed at a control that owns the key, is left alone.
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

  // Only what there is a choice about: a single rendition, a single dub or no
  // subtitles at all is a group with nothing in it, and an empty group is
  // worse than none.
  const settingGroups: SettingGroup[] = []
  // Gated on the bucket the same way the <track> elements are: without one
  // these are tracks the browser can never fetch, so offering them is offering
  // a choice that cannot take effect.
  if (room.mediaBaseUrl && subtitleTracks.length > 0) {
    settingGroups.push({
      id: 'subtitles',
      label: t('room.subtitles'),
      current: subtitle,
      onPick: setSubtitle,
      options: [
        { value: -1, label: t('room.off') },
        // Keyed by the track's own number, never by its place in the list:
        // the list grows as the extraction runs, and a choice remembered as a
        // position slides onto another language mid-episode.
        ...subtitleTracks.map((track) => ({
          value: track.index,
          label: track.title || track.language || String(track.index + 1),
        })),
      ],
    })
  }
  if (audioTracks.length > 1) {
    settingGroups.push({
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
    settingGroups.push({
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

  const seekMax = Math.max(timelineEnd, 1)
  const pct = (seconds: number) => `${(Math.min(Math.max(seconds, 0), seekMax) / seekMax) * 100}%`
  // The source's authored spans, clamped to what is seekable right now:
  // during the preview the playable range is still growing, and a marker past
  // its end would sit on the far edge pointing at nothing. Each keeps its
  // position in the full list, so unnamed chapters are numbered as the
  // source counts them, not as the clamp happens to leave them.
  const chapters = (room.chapters ?? [])
    .map((chapter, index) => ({ ...chapter, ordinal: index + 1 }))
    .filter((chapter) => chapter.startMs / 1000 < seekMax)
  const chapterLabel = (index: number) =>
    chapters[index].title || `${t('player.chapter')} ${chapters[index].ordinal}`
  const chapterIndexAt = (seconds: number) =>
    chapters.findIndex((chapter) => seconds * 1000 >= chapter.startMs && seconds * 1000 < chapter.endMs)
  const currentChapterIndex = chapterIndexAt(currentTime)
  // What the pointer is over on the scrubber: a chapter and its span, or just
  // the time, floating above the bar.
  const [seekHover, setSeekHover] = useState<{ leftPct: number; text: string } | null>(null)
  // Each buffered range is split at the playhead: buffer kept behind it is a
  // different fact than buffer ready ahead of it, and both are drawn over the
  // played and unbuffered ground.
  const behindBands: Array<{ from: number; to: number }> = []
  const aheadBands: Array<{ from: number; to: number }> = []
  for (const range of bufferedRanges) {
    const start = Math.min(Math.max(range.start, 0), seekMax)
    const end = Math.min(Math.max(range.end, 0), seekMax)
    if (start < Math.min(currentTime, end)) behindBands.push({ from: start, to: Math.min(currentTime, end) })
    if (end > Math.max(start, currentTime)) aheadBands.push({ from: Math.max(start, currentTime), to: end })
  }
  // A player waiting on data looks exactly like one that has stopped working.
  // The spinner is the only thing that distinguishes them, and a room whose
  // source is still downloading spends real time here.
  const [loading, setLoading] = useState(true)
  // A short wait is buffering; a long one on a downloading source is the
  // swarm, and saying so beats a bare spinner turning for minutes.
  const [stalledLong, setStalledLong] = useState(false)
  useEffect(() => {
    if (!loading) {
      setStalledLong(false)
      return
    }
    const timer = window.setTimeout(() => setStalledLong(true), 3_000)
    return () => window.clearTimeout(timer)
  }, [loading])

  // The controller defines the room position, so it can never be out of sync
  // with itself; LIVE exists only for viewers.
  const expectedMs = !isController && syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : null
  const atLiveEdge = expectedMs === null || Math.abs(currentTime * 1000 - expectedMs) <= LIVE_SYNC_THRESHOLD_MS

  return (
    <div
      ref={playerRef}
      className={`player-wrap ${playing && !controlsVisible ? 'controls-hidden' : ''}`}
      onPointerMove={() => revealControls(playing)}
      onPointerDown={() => revealControls(playing)}
      onFocusCapture={() => revealControls(false)}
      onBlurCapture={() => revealControls(playing)}
      onClick={(event) => {
        // The control bar has its own buttons; a click there is theirs.
        if ((event.target as HTMLElement).closest('.player-controls')) return
        cancelPendingTap()
        tapTimerRef.current = setTimeout(() => {
          tapTimerRef.current = null
          if (togglePlay()) {
            showFeedback(videoRef.current?.paused ? <Play size={26} /> : <Pause size={26} />)
          }
        }, TAP_TOGGLE_DELAY_MS)
      }}
      onDoubleClick={(event) => {
        // Ignore double clicks aimed at the control bar, where they would
        // otherwise fullscreen the player while someone is dragging a slider.
        if ((event.target as HTMLElement).closest('.player-controls')) return
        cancelPendingTap()
        toggleFullscreen()
      }}
    >
      {loading ? (
        <div className="player-loading" role="status" aria-live="polite">
          <span className="player-spinner" aria-hidden="true" />
          {stalledLong ? (
            <div className="player-preparing">
              <span>{t('room.preparingPart')}</span>
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
        // Subtitle files live on the media host, and a browser refuses to load
        // a cross-origin text track unless the media element itself declares
        // CORS. Without this the tracks are listed and never fetched.
        crossOrigin="anonymous"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onStalled={() => setLoading(true)}
        onSeeking={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onSeeked={() => setLoading(false)}
        onCanPlay={() => {
          // canplay fires with enough data buffered to advance, which is the
          // honest moment to stop saying "loading" even while still paused.
          setLoading(false)
          attemptPlay()
        }}
        onTimeUpdate={(event) => {
          // The element's clock belongs to the source it holds: between a
          // region choice and its reload the state offset is already the new
          // one, and pairing it with the old element's time would name an
          // absolute position nobody is at.
          const loadedOffset = loadedOffsetSecRef.current
          const absoluteSec = event.currentTarget.currentTime + loadedOffset
          setCurrentTime(absoluteSec)
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(shiftRanges(readBufferedRanges(event.currentTarget), loadedOffset))
          // Playback walking off the end of a finished region continues in
          // the region that picks up there, if one does — judged only while
          // the element holds the region the state says it does.
          if (regions && loadedOffset === mediaOffsetSec) {
            const next = regionFor(regions, absoluteSec * 1000, activeRegionN)
            if (next !== null && next !== activeRegionN) setActiveRegionN(next)
          }
        }}
        onDurationChange={(event) => setDuration(playableDuration(event.currentTarget))}
        onLoadedMetadata={(event) => setDuration(playableDuration(event.currentTarget))}
        onProgress={(event) => {
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(shiftRanges(readBufferedRanges(event.currentTarget), mediaOffsetSec))
        }}
      >
        {(room.mediaBaseUrl ? (room.subtitleTracks ?? []) : []).map((track) => (
          <track
            // The versions are in the key on purpose: browsers do not reliably
            // refetch a <track> whose src attribute merely changed, so a grown
            // subtitle file only reaches the viewer as a fresh element.
            // mediaVersion rides along so a region switch remounts the
            // element: cues are shifted onto the region's rebased clock at
            // load, and a fresh load is the only moment that shift is safe.
            key={`${track.index}-${track.language}-${room.mediaGeneration}-${room.mediaVersion ?? 0}-${room.subsVersion ?? 0}`}
            kind="subtitles"
            onLoad={(event) => shiftTrackCues(event.currentTarget.track, mediaOffsetSec)}
            src={subtitleSource(room, track.index, track.language)}
            srcLang={track.language || 'und'}
            label={track.title || track.language || `Subtitle ${track.index + 1}`}
          />
        ))}
      </video>
      <SubtitleLayer
        videoRef={videoRef}
        position={subtitleTracks.findIndex((track) => track.index === subtitle)}
        revision={`${room.mediaGeneration}-${room.mediaVersion ?? 0}-${room.subsVersion ?? 0}-${subtitleCount}`}
      />
      {feedback ? <span key={feedback.id} className="player-feedback" aria-hidden="true">{feedback.node}</span> : null}
      {unplayable ? <div className="player-unplayable" role="alert">{t('room.unplayable')}</div> : null}
      <div className="player-controls">
        {/* The scrubber owns the full width of the bar; everything that acts on
            what it points at sits underneath it. */}
        <div
          className="seek-control"
          onPointerMove={(event) => {
            // A finger is not a hover: on touch the only pointermove is the
            // drag itself, and with no pointerout coming the label would
            // stay pinned wherever the drag ended.
            if (event.pointerType === 'touch') return
            const rect = event.currentTarget.getBoundingClientRect()
            if (rect.width <= 0) return
            const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
            const seconds = frac * seekMax
            const index = chapterIndexAt(seconds)
            // The section under the pointer and the time the pointer is at —
            // what a click would seek to — not the chapter's own span.
            const text = index >= 0
              ? `${chapterLabel(index)} · ${formatTime(seconds)}`
              : formatTime(seconds)
            setSeekHover({ leftPct: Math.min(Math.max(frac * 100, 6), 94), text })
          }}
          onPointerLeave={() => setSeekHover(null)}
          onPointerCancel={() => setSeekHover(null)}
        >
          <div className="seek-track" aria-hidden="true">
            <div className="seek-played" style={{ width: pct(scrubSec ?? pendingSeekSec ?? currentTime) }} />
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
            {/* Chapter boundaries read as gaps cut into the bar, whatever is
                painted under them at that point. */}
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
            value={Math.min(scrubSec ?? pendingSeekSec ?? currentTime, seekMax)}
            disabled={!isController}
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
              // Mid-drag the gesture only moves the thumb; the one seek is
              // sent on release. Keyboard changes have no gesture and commit
              // immediately.
              if (scrubbingRef.current) setScrubSec(seconds)
              else seek(seconds)
            }}
          />
          {seekHover ? (
            <span className="seek-tooltip" aria-hidden="true" style={{ left: `${seekHover.leftPct}%` }}>{seekHover.text}</span>
          ) : null}
        </div>
        {/* What is playing on the left, how it is played on the right. */}
        <div className="controls-row">
          <button
            className="control-button is-play"
            aria-label={playLabel}
            title={`${playLabel} (Space)`}
            onClick={togglePlay}
            onPointerUp={(event) => event.currentTarget.blur()}
          >{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
          <span className="timecode">
            {formatTime(currentTime)} / {formatTime(timelineEnd)}
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
          <div className="volume-control">
            <button
              className="control-button"
              aria-label={muteLabel}
              title={`${muteLabel} (M)`}
              onClick={toggleMute}
              onPointerUp={(event) => event.currentTarget.blur()}
            >{volumeIcon(muted ? 0 : volume, 16)}</button>
            <div className="volume-panel">
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
      {/* Room-level overlays (sync panel, next-episode card) render inside
          the wrap, so they survive fullscreen — fixed elements outside the
          fullscreen element simply do not paint there. */}
      {overlay}
    </div>
  )
}

// Keystrokes meant for a text field or an already focused control must never
// be stolen by the player. Space activates buttons and links, and both arrow
// keys drive range inputs and selects natively.
// focusOwnsKey reports whether the focused element should keep a key for
// itself instead of letting it reach the player's shortcuts.
//
// Text entry keeps everything. So does any control outside the player, whose
// keys are none of the player's business. Inside the player the rule inverts:
// the control bar must not shadow the shortcuts of the player it belongs to.
// Clicking pause leaves that button focused, and Space would press it again
// rather than resume — which reads as the shortcut being ignored.
//
// The sliders and the track picker are the exception, keeping the arrows they
// use to change their own value.
function focusOwnsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true

  const insidePlayer = target.closest('.player-wrap') !== null
  switch (target.tagName) {
    case 'INPUT':
      // A range slider is a control; every other input takes typing.
      if ((target as HTMLInputElement).type !== 'range') return true
      // The volume slider keeps its arrows. The scrubber does not: its native
      // step is one second, and a focused scrubber must not shrink the room's
      // five-second seek — the shortcut's preventDefault stops the double move.
      return !insidePlayer || (isArrowKey(key) && !target.closest('.seek-control'))
    case 'SELECT':
    case 'OPTION':
      // Space is how a picker opens, so it keeps that one too.
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

// video.buffered can hold several disjoint ranges — a seek leaves islands
// behind — and the scrub bar draws every one of them.
function readBufferedRanges(video: HTMLVideoElement): BufferedRange[] {
  const ranges: BufferedRange[] = []
  for (let index = 0; index < video.buffered.length; index += 1) {
    ranges.push({ start: video.buffered.start(index), end: video.buffered.end(index) })
  }
  return ranges
}

// Buffered ranges come off the element's rebased clock; the scrubber speaks
// absolute room time.
function shiftRanges(ranges: BufferedRange[], offsetSec: number): BufferedRange[] {
  if (offsetSec === 0) return ranges
  return ranges.map((range) => ({ start: range.start + offsetSec, end: range.end + offsetSec }))
}

// Subtitle cues are timed against the source; a region's media clock starts
// at the region, so every cue moves back by the offset. Cues that end before
// the region simply leave.
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

// One greppable prefix for the player's whole account of a session: codec
// verdicts, dropped levels, recoveries and the reason it gave up. A bug report
// is otherwise a shrug — none of these failures surface in the UI until the
// player decides the room is unplayable.
function plog(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  console[level]('[ss-player]', ...parts)
}

// A playlist loader that deletes every CODECS attribute from the multivariant
// playlist, so hls.js probes the init segments instead of trusting a codec
// string some ffmpeg releases render invalidly. Used only for the retry after
// every declared codec was rejected up front.
function codecStrippingLoader(HlsClass: HlsModule['default']): HlsConfig['pLoader'] {
  const Base = HlsClass.DefaultConfig.loader
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
