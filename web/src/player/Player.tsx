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
import { Settings, type SettingGroup } from './Settings'
import { SubtitleLayer } from './SubtitleLayer'
import { Timecode } from './Timecode'
import { MOCK_AUDIO_TRACKS, MOCK_LEVELS, mocksEnabled } from '../mocks'
import { TorrentReadout } from '../components/TorrentReadout'
import { WaitLabel } from './WaitLabel'
import { bufferAhead, holdsForBuffer } from './bufferAhead'
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
  // Hands the room-aware seek out, so a jump from outside the bar (the
  // chapter list) parks and resumes the room exactly like the scrubber.
  seekRef?: MutableRefObject<((seconds: number) => void) | null>
  // Raised while the room's position is in media no region has produced yet.
  // The sync layer reads it to stop steering the element: resyncing then
  // would clamp into the old region and play the wrong minutes under a
  // clock that says otherwise.
  coldWaitRef?: MutableRefObject<boolean>
  // Stamped by the sync layer whenever a server frame steers the element, so
  // the pause it produces is not mistaken for one the viewer performed.
  remoteSteerAtRef?: MutableRefObject<number>
  // The sync layer could not start this viewer's element, muted or otherwise:
  // the room is playing and only a click of theirs will join them to it.
  autoplayBlocked?: boolean
  // Where this player hands its buffering picture back to the sync layer.
  // The room waits on these reports, so a player that never sends one — or
  // never stops — is a room that never starts.
  onBuffering?: (stalled: boolean) => void
}

// How far past a growing region's produced edge a position still counts as
// its: the pipeline is on its way there. Mirrors the pipeline's own margin.
const REGION_AHEAD_MS = 30_000
// How long a play intent stays worth retrying. Long enough for hls.js to
// finish attaching, short enough that it cannot resurrect a stopped room.
const PLAY_INTENT_TTL_MS = 5_000
// How long after a server frame steered the element its own play/pause events
// are read as echo rather than as something the viewer did.
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
 * The version that is allowed to rebuild the player.
 *
 * A region still growing republishes every couple of seconds, and every one
 * of those bumps the room's media version. Rebuilding on each meant tearing
 * the whole picture down and putting it back twice a minute for as long as a
 * file took to prepare — the audio came back first, because its segments are
 * small, so the picture sat frozen under a soundtrack that kept going. The
 * subtitles remounted with it and blinked in time.
 *
 * hls.js follows a growing live playlist by itself: there is nothing to
 * rebuild for while a region grows, so the version is pinned. A region that
 * has stopped growing is the other case the version exists for — the final
 * remux replacing the progressive preview — and that one still reloads.
 */
export function reloadVersion(region: { growing?: boolean } | null, version: number | undefined): number {
  if (region?.growing) return 0
  return version ?? 0
}

// TAP_TOGGLE_DELAY_MS is how long a tap waits to see whether it is really the
// first half of a double click. Long enough for a deliberate double click,
// short enough that pausing still feels like it happened on contact.
const TAP_TOGGLE_DELAY_MS = 200

const NO_SUBTITLE_TRACKS: NonNullable<RoomInfo['subtitleTracks']> = []

const SEEK_STEP_SECONDS = 5
const SEEK_STEP_LARGE_SECONDS = 10
const VOLUME_STEP = 0.05
// Long enough to read the symbol, short enough that holding an arrow key still
// feels like scrubbing rather than a stack of notifications.
// How long a pointer may linger in the gap between the volume button and its
// slider before the panel gives up on it. Long enough for a hand that pauses
// mid-reach, short enough that a panel nobody wants does not sit there.
const VOLUME_CHASE_MS = 500
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
// How much media has to be ready ahead of the playhead before playback is let
// go. Starting on the first frame that arrives is what makes a room stutter
// through its opening seconds: the pipeline publishes four-second segments,
// so anything less than a few of them means playing straight back into the
// wait that just ended. Ten seconds is short enough not to be its own delay.
const BUFFER_GATE_SEC = 10

export interface BufferedRange {
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
function subtitleSource(room: RoomInfo, track: TrackInfo): string {
  // The track's own digest when the server named one: a republished set is
  // mostly tracks that did not change, and a room-wide version would send
  // every viewer back for all of them. Falls back to the room version for a
  // server extraction, which has no digests and does not republish.
  const version = `?g=${room.mediaGeneration}&s=${track.digest ?? room.subsVersion ?? 0}`
  return `${room.mediaBaseUrl}/subs/sub_${track.index}_${safeLanguage(track.language)}.vtt${version}`
}

export function Player({ room, isController, videoRef, send, t, syncState, serverOffsetMs = 0, swarm, overlay, onChapters, mediaOffsetMsRef, seekRef, coldWaitRef, remoteSteerAtRef, autoplayBlocked, onBuffering }: PlayerProps) {
  const { toast } = useToast()
  // Says why a control did nothing, at the moment it is used. The standing
  // note this replaces sat in the bar for the whole session, explaining
  // something nobody had tried yet.
  const refuseControl = useCallback(() => toast(t('room.controllerOnly')), [t, toast])
  const playerRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
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
  // When the intent was formed. A play kept alive across a rebuild is a
  // retry; the same play half a minute later is a ghost that restarts a room
  // somebody deliberately stopped.
  const playRequestedAtRef = useRef(0)
  const playAttemptRef = useRef(false)
  // Carries "the room was playing" through an hls.js teardown. destroy()
  // calls media.load(), which pauses the element, and a region switch sends
  // no state message — so without this the picture simply stops and only the
  // clock keeps moving.
  const resumeAfterReloadRef = useRef(false)
  // Raised when the browser refused to start playback without a gesture.
  const [needsGesture, setNeedsGesture] = useState(false)
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
  // Whether the element has something it can actually advance through right
  // now. Declared up here because the controls consult it before they are
  // allowed to command the room.
  const [loading, setLoading] = useState(true)
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
  const masterName = activeRegion ? `r${activeRegion.n}_master.m3u8` : 'master.m3u8'
  const mediaReload = reloadVersion(activeRegion, room.mediaVersion)
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
  // Where the room is pointed, and whether any region has media under it.
  // While none does, the pipeline is on its way: the element must not play —
  // hls.js would clamp into the old region and show the wrong minutes — and
  // the viewer is told what the wait is instead.
  const coldTargetMs = syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : null
  // A room with no region map is read as the one region it is: the element's
  // own loaded span, from the room's offset, still growing. Without this the
  // wait only protected rooms that had already been sought in, and a room
  // whose clock ran past what exists — a tab that slept, a laptop that
  // closed — went back to hls.js clamping to the live edge and the sync
  // layer dragging it forward again, over and over.
  const coldRegions = regions ?? (duration > 0
    ? [{ n: 0, startMs: mediaOffsetMs, producedMs: Math.round(duration * 1000), growing: true }]
    : null)
  // Past the room's known end there is no region still coming, so waiting
  // there is waiting for nothing: the film ended, the clock kept running, and
  // the player used to sit forever on "preparing" with a play button that did
  // nothing. Same bound Room.tsx already uses to decide a resume is possible.
  const knownEndMs = room.durationMs && room.durationMs > 0 ? room.durationMs : null
  // Only once the regions actually reach that end: a room whose clock ran off
  // the front of a pipeline still building the middle is a different wait,
  // and it must keep waiting.
  const producedToEnd = knownEndMs !== null && coldRegions !== null
    && coldRegions.some((r) => regionHolds(r, knownEndMs - 1))
  const coldWait = coldRegions !== null && coldTargetMs !== null
    && !(producedToEnd && coldTargetMs >= (knownEndMs ?? 0))
    && !coldRegions.some((r) => regionHolds(r, coldTargetMs))
  if (coldWaitRef) coldWaitRef.current = coldWait
  useEffect(() => {
    if (!coldWait) return
    // The hold is deliberate, so a play still waiting to be retried must not
    // survive it and fire the moment the buffer recovers.
    playRequestedRef.current = false
    videoRef.current?.pause()
  }, [coldWait, videoRef])
  // What the scrubber and the clock read. While the target is cold the element
  // is still sitting in the region it already had — a different part of the
  // film — and its clock jumps again on every region switch, which is the
  // thumb wandering to arbitrary moments after a seek into a big torrent.
  // The room's own clock is the only thing that knows where we are then.
  const shownSec = coldWait && coldTargetMs !== null ? coldTargetMs / 1000 : currentTime

  // The timeline is the room's, not the element's: the scrubber promises the
  // whole episode from the first publish, while the element grows region by
  // region behind it.
  const timelineEnd = room.durationMs ? room.durationMs / 1000 : duration + mediaOffsetSec
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([])
  const [playing, setPlaying] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  // The volume panel floats above the bar, in the video's own space. While it
  // is open the bar may not retire: hiding it takes the panel with it — and
  // with pointer-events too — so the slider would vanish from under the very
  // pointer reaching for it. Read through a ref because revealControls is
  // handed to pointer handlers and must not be rebuilt as this changes.
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeOpenRef = useRef(false)
  volumeOpenRef.current = volumeOpen
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [feedback, setFeedback] = useState<{ id: number; node: ReactNode } | null>(null)
  // Why playback stopped, not merely that it did. Only a real codec refusal
  // may tell someone their browser is the problem: a cold seek that starves
  // the decoder looks identical from here, and sending them off to install
  // Chrome over a region that had not arrived yet is a wrong answer told
  // confidently.
  const [unplayable, setUnplayable] = useState<{ cause: 'codec' | 'playback'; reason: string } | null>(null)
  const recoveriesRef = useRef(0)
  const resumeRef = useRef({ generation: -1, time: 0 })

  // A pointer sweep across the video calls this once per pointermove — a
  // clearTimeout, a setTimeout and a state dispatch each time, while the
  // decoder is already competing for the main thread. While a hide is already
  // pending, re-arming it again within the same 150ms changes nothing anyone
  // can see: the bar still goes 2.5s after the last movement, to within the
  // gate. With no timer pending there is nothing to skip, and the reveal runs.
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
    // Closing the panel hands the bar back to its own clock, so it retires
    // on its own the moment the volume is no longer being set.
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
    const source = `/media/${encodeURIComponent(room.id)}/hls/${masterName}?g=${generation}&v=${mediaReload}`
    let disposed = false
    setUnplayable(null)
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
    // The shared ref pairs with the element's clock everywhere it is read,
    // so it moves when the element does, not a render earlier.
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
              if (!alternate) failPlayback(`no decodable video rendition (${failed})`, 'codec')
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
            failPlayback('no compatible codecs in manifest', 'codec')
            return
          }
          if (undecodable.has(data.details)) {
            failPlayback(`undecodable media (${data.details})`, 'codec')
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
      resumeRef.current = { generation, time: video.currentTime + loadedOffsetSecRef.current }
      // destroy() runs the element's load algorithm, which pauses it. A
      // region switch or a republish sends no state message, so nobody would
      // ever start it again: the picture freezes while the room's clock walks
      // away from it. Captured here, not in the effect body — React runs this
      // cleanup first, so by then the element is already paused.
      resumeAfterReloadRef.current = syncRef.current?.playing ?? !video.paused
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, room.mediaGeneration, mediaReload, mediaOffsetSec, masterName, videoRef])

  // A different recording must not inherit the previous one's intent.
  useEffect(() => { resumeAfterReloadRef.current = false }, [room.mediaGeneration])

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
  // The empty case is a shared constant, not a fresh literal: a room with no
  // subtitles handed every memo and every effect below a new array on each
  // render, which is the same as having no memo at all.
  const subtitleTracks = room.subtitleTracks ?? NO_SUBTITLE_TRACKS
  const subtitleCount = subtitleTracks.length
  useEffect(() => {
    const textTracks = videoRef.current?.textTracks
    if (!textTracks) return
    // Only the chosen one: "hidden" is what makes a browser fetch and parse a
    // track's file, and a release with two dozen of them would pull every one
    // down to draw a single line of text.
    const chosen = subtitleTracks.findIndex((track) => track.index === subtitle)
    for (let position = 0; position < Math.min(textTracks.length, subtitleCount); position += 1) {
      // "hidden", never "showing": a hidden track still parses its file and
      // still reports which cues are active, but the browser does not draw it.
      // SubtitleLayer draws the chosen one, because Chrome renders a native
      // track in the operating system's caption style and ignores the page's
      // ::cue rules — the black slab and the clipped descenders come from there
      // and cannot be styled away.
      textTracks[position].mode = position === chosen ? 'hidden' : 'disabled'
    }
  }, [subtitle, subtitleCount, subtitleTracks, room.subsVersion, room.mediaGeneration, mediaReload, videoRef])

  // The position a play or pause speaks for the room. The element's clock
  // only counts while it holds the room's position: after a cold seek it
  // still sits in the old region while the new one is prepared, and a play
  // sent with that clock would drag the whole room back to it.
  const commandPositionMs = useCallback((video: HTMLVideoElement): number => {
    const elementMs = Math.round((video.currentTime + loadedOffsetSecRef.current) * 1000)
    const sync = syncRef.current
    if (!sync) return elementMs
    const expected = expectedPositionMs(sync, Date.now() + serverOffsetRef.current)
    return Math.abs(elementMs - expected) > 5_000 ? Math.round(expected) : elementMs
  }, [])

  const attemptPlay = useCallback(() => {
    const video = videoRef.current
    if (!video || !playRequestedRef.current || playAttemptRef.current) return
    // An intent nobody could satisfy within a few seconds is not a retry any
    // more: firing it later restarts a room that has since been stopped.
    if (Date.now() - playRequestedAtRef.current > PLAY_INTENT_TTL_MS) {
      playRequestedRef.current = false
      return
    }
    // A viewer never plays against a stopped room. Only the controller
    // decides that, and their own play goes through togglePlay.
    if (!isController && syncRef.current && !syncRef.current.playing) {
      playRequestedRef.current = false
      return
    }
    // Held, not dropped: the intent stands and the effect below tries again
    // the moment the buffer is deep enough. Its expiry is restamped while it
    // waits, because that clock is there to expire an intent nobody could
    // satisfy in a few seconds, and this is a wait we asked for: left alone
    // it would drop every play that took longer than the gate to fill.
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
      if (isController) {
        send('play', { positionMs: commandPositionMs(video), rate: video.playbackRate })
      }
    }).catch((error: unknown) => {
      playAttemptRef.current = false
      // A click can land while hls.js is still attaching the MediaSource, or
      // a pause can abort a play that never started: keep the intent and
      // retry from the next canplay. A refusal for want of a gesture is the
      // opposite — retrying only produces rejected promises forever — so the
      // intent is dropped and the viewer is asked for the one click that
      // fixes it.
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        playRequestedRef.current = false
        setNeedsGesture(true)
      }
    })
  }, [commandPositionMs, isController, send, videoRef])

  // Arms a play intent. Every caller goes through here so nobody forgets to
  // stamp it, which is what gives the retry its expiry.
  const requestPlay = useCallback(() => {
    playRequestedRef.current = true
    playRequestedAtRef.current = Date.now()
    attemptPlay()
  }, [attemptPlay])

  // When the wait ends with the room playing — the region landed while the
  // element was held paused — nobody sends a new state message, so the
  // element is nudged back into playback here. Only the transition out of
  // the wait nudges; an ordinary mount plays through its own paths.
  // Whether the controls have anything to command. Not plain `loading`: that
  // is true from the first paint and on every momentary flicker, and a play
  // button that is dead before the first frame — or that dies whenever a
  // buffer dips — is worse than the problem. It is the wait people actually
  // see: no media for this position at all, or a load that has gone on long
  // enough for the spinner to have earned its explanation.
  //
  // A ref beside the state because togglePlay is handed to keyboard and
  // pointer handlers, and rebuilding it on every flicker would re-bind them
  // constantly for a value only read at the moment of a press.
  const notReadyRef = useRef(false)

  const wasColdRef = useRef(false)
  useEffect(() => {
    const wasCold = wasColdRef.current
    wasColdRef.current = coldWait
    if (coldWait || !wasCold || !syncRef.current?.playing) return
    const video = videoRef.current
    if (!video || !video.paused) return
    requestPlay()
  }, [coldWait, requestPlay, videoRef])

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

    // Nothing to start or stop while the media under this position is still
    // arriving. A play here writes a state the room cannot honour and the
    // pause that follows races the pipeline: the two commands chase each
    // other and the room ends up somewhere nobody chose.
    if (notReadyRef.current) return false

    if (!isController) {
      // A viewer's gesture never changes what the room is doing. The one thing
      // it may do is start their own element when the room is already playing
      // and the browser refused to autoplay it — catching up, not controlling.
      // attemptPlay only reports a play upstream for the controller, so this
      // stays local while still inheriting the retry on canplay.
      if (video.paused && syncState?.playing) {
        requestPlay()
        return true
      }
      refuseControl()
      return false
    }

    resumeAtMsRef.current = null
    if (video.paused) {
      // Calling play inside the gesture preserves browser user activation. A
      // WebSocket round trip first would make browsers reject audible autoplay.
      // A cold target never reaches here: the guard above refuses while the
      // region is still being built, and the seek that parked the room there
      // already sent its pause.
      requestPlay()
      return true
    }
    playRequestedRef.current = false
    video.pause()
    send('pause', { positionMs: commandPositionMs(video), rate: video.playbackRate })
    return true
  }, [commandPositionMs, isController, refuseControl, requestPlay, send, syncState, videoRef])

  // A pause the viewer performed on the element itself — a media key, the
  // system's now-playing sheet, picture-in-picture — used to stop only them.
  // The controller was certain they had paused the room, and the room played
  // on without them.
  const reportNativeToggle = useCallback((playing: boolean) => {
    if (!isController || coldWait) return
    const sync = syncRef.current
    if (!sync || sync.playing === playing) return
    // A frame from the server steers the element too, and the DOM event it
    // produces is indistinguishable from a real gesture. Echoing it back
    // would have the room command itself.
    if (Date.now() - (remoteSteerAtRef?.current ?? 0) < REMOTE_ECHO_MS) return
    const video = videoRef.current
    if (!video) return
    if (!playing) playRequestedRef.current = false
    send(playing ? 'play' : 'pause', { positionMs: commandPositionMs(video), rate: video.playbackRate })
  }, [coldWait, commandPositionMs, isController, remoteSteerAtRef, send, videoRef])

  // The end of the film is a pause nobody sends. Left alone the room's clock
  // runs past everything that exists, the player decides it is waiting for a
  // region that will never be published, and the play button stops doing
  // anything at all.
  const reportEnded = useCallback(() => {
    if (!isController) return
    const video = videoRef.current
    const sync = syncRef.current
    if (!video || !sync?.playing) return
    const end = room.durationMs && room.durationMs > 0
      ? room.durationMs
      : Math.round((video.duration + loadedOffsetSecRef.current) * 1000)
    // 'ended' also fires at the close of a finished region mid-episode. Only
    // the end of the room's own timeline stops the room.
    const expected = expectedPositionMs(sync, Date.now() + serverOffsetRef.current)
    if (room.durationMs && expected < room.durationMs - REGION_BEHIND_MS * 5) return
    playRequestedRef.current = false
    send('pause', { positionMs: end, rate: video.playbackRate })
  }, [isController, room.durationMs, send, videoRef])

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
      playRequestedRef.current = false
      send('pause', { positionMs: Math.round(seconds * 1000), rate: video.playbackRate })
    }
  }, [duration, isController, mediaOffsetSec, regions, send, serverOffsetMs, syncState, videoRef])
  if (seekRef) seekRef.current = seek

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
  // Keyed on the state's identity, not on the boolean: by the time a rejected
  // play is waiting for its retry the room is usually already stopped, so a
  // transition-only effect would never fire.
  useEffect(() => {
    if (syncState && !syncState.playing) {
      playRequestedRef.current = false
      setNeedsGesture(false)
    }
  }, [syncState])

  // A refusal the sync layer met on arrival wears the same face as one this
  // player met: the room is playing and this viewer is not, and the way in is
  // the one click the overlay asks for.
  useEffect(() => {
    if (autoplayBlocked) setNeedsGesture(true)
  }, [autoplayBlocked])

  // The thumb holds the committed target until the video actually gets
  // there — on a cold seek that is however long the new region takes.
  useEffect(() => {
    // Not while the wait is on: the element's clock belongs to the region it
    // still holds, and letting it release the target hands the thumb back to
    // a position nobody asked for.
    if (coldWait) return
    if (pendingSeekSec !== null && Math.abs(currentTime - pendingSeekSec) < 3) setPendingSeekSec(null)
  }, [coldWait, currentTime, pendingSeekSec])

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

  // Leaving the button for the slider crosses a gap neither of them covers,
  // so the pointer is followed across it: while it stays inside the triangle
  // aimed at the panel, the panel stays. A move that turns away leaves the
  // triangle on its very next event and closes it at once, so nothing hangs
  // around that nobody is reaching for. The timeout is for a pointer that
  // simply stops in the gap and never arrives.
  const volumeRef = useRef<HTMLDivElement>(null)
  const volumePanelRef = useRef<HTMLDivElement>(null)
  const chaseRef = useRef<(() => void) | null>(null)
  // A slider being dragged is the one thing that must never close the panel.
  // Pressing it hands the input implicit pointer capture, which fires leave
  // on the control behind it, so the drag announces itself as a departure —
  // and the pointer then travels wherever the hand goes, well outside both
  // the panel and the corridor. Nothing closes until the button comes up.
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
      // A drag that ended away from the control has no hover left to leave,
      // so this is the only moment that can retire the panel.
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
  const settingGroups: SettingGroup[] = useMemo(() => {
    const groups: SettingGroup[] = []
    // Gated on the bucket the same way the <track> elements are: without one
    // these are tracks the browser can never fetch, so offering them is offering
    // a choice that cannot take effect.
    if (room.mediaBaseUrl && subtitleTracks.length > 0) {
      groups.push({
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
  // The source's authored spans, clamped to what is seekable right now:
  // during the preview the playable range is still growing, and a marker past
  // its end would sit on the far edge pointing at nothing. Each keeps its
  // position in the full list, so unnamed chapters are numbered as the
  // source counts them, not as the clamp happens to leave them.
  const chapters = useMemo(() => (room.chapters ?? [])
    .map((chapter, index) => ({ ...chapter, ordinal: index + 1 }))
    .filter((chapter) => chapter.startMs / 1000 < seekMax), [room.chapters, seekMax])
  const chapterLabel = useCallback((index: number) =>
    chapters[index].title || `${t('player.chapter')} ${chapters[index].ordinal}`, [chapters, t])
  const chapterIndexAt = useCallback((seconds: number) =>
    chapters.findIndex((chapter) => seconds * 1000 >= chapter.startMs && seconds * 1000 < chapter.endMs), [chapters])
  const currentChapterIndex = chapterIndexAt(currentTime)
  // What the pointer is over on the scrubber: a chapter and its span, or just
  // the time, floating above the bar.
  const [seekHover, setSeekHover] = useState<{ leftPct: number; text: string } | null>(null)
  const hoverRectRef = useRef<DOMRect | null>(null)
  // Each buffered range is split at the playhead: buffer kept behind it is a
  // different fact than buffer ready ahead of it, and both are drawn over the
  // played and unbuffered ground.
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
  // Held for buffer, rather than for media that does not exist yet: a cold
  // seek has its own wait and its own words for it.
  const bufferGate = !coldWait && holdsForBuffer({
    aheadSec: bufferAheadSec,
    gateSec: BUFFER_GATE_SEC,
    currentTime,
    timelineEnd,
    playing,
    ready: duration > 0,
  })
  const bufferGateRef = useRef(bufferGate)
  bufferGateRef.current = bufferGate
  // The gate opening is the one event that ends its own wait: no canplay or
  // progress necessarily follows a buffer that filled while the element was
  // paused. Declared here, below the gate it reads: a dependency array is
  // evaluated while the component body runs, so referencing it any earlier is
  // a use before initialisation that no type check would catch.
  useEffect(() => {
    if (bufferGate) return
    attemptPlay()
  }, [bufferGate, attemptPlay])

  // A player waiting on data looks exactly like one that has stopped working.
  // The spinner is the only thing that distinguishes them, and a room whose
  // source is still downloading spends real time here.
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
  const controlsBlocked = coldWait || stalledLong
  notReadyRef.current = controlsBlocked

  // The controller defines the room position, so it can never be out of sync
  // with itself; LIVE exists only for viewers.
  const expectedMs = !isController && syncState ? expectedPositionMs(syncState, Date.now() + serverOffsetMs) : null
  const atLiveEdge = expectedMs === null || Math.abs(currentTime * 1000 - expectedMs) <= LIVE_SYNC_THRESHOLD_MS

  // A click low in the frame is a hand going for the bar, not a request to
  // pause. The whole strip the control row occupies is off limits, not only
  // the buttons inside it — missing the scrubber by a few pixels used to
  // pause the room for everyone. While the controls are hidden the strip is
  // not there, and the frame is one big play/pause target again.
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
              {/* Counting what is still missing rather than what is held: the
                  number a person is waiting on is the one that reaches zero.
                  Only once there is media to fill against, so a cold seek
                  still says it is preparing instead of promising ten seconds
                  of a region that does not exist. */}
              <WaitLabel
                secondsLeft={bufferGate && !coldWait
                  ? Math.max(Math.ceil(BUFFER_GATE_SEC - bufferAheadSec), 1)
                  : null}
                t={t}
              />
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
        onCanPlay={() => {
          // canplay fires with enough data buffered to advance, which is the
          // honest moment to stop saying "loading" even while still paused.
          setLoading(false)
          onBuffering?.(false)
          const media = videoRef.current
          if (resumeAfterReloadRef.current && !coldWait && media?.paused) {
            resumeAfterReloadRef.current = false
            // Straight to the element, never through requestPlay: a rebuild is
            // nobody's gesture, and the controller must not announce a play to
            // the room over a region switch it never asked for.
            void media.play().catch(() => undefined)
          }
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
          setBufferedRanges(keepRanges(shiftRanges(readBufferedRanges(event.currentTarget), loadedOffset)))
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
          setBufferedRanges(keepRanges(shiftRanges(readBufferedRanges(event.currentTarget), mediaOffsetSec)))
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
            key={`${track.index}-${track.language}-${room.mediaGeneration}-${mediaReload}-${track.digest ?? room.subsVersion ?? 0}`}
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
        position={subtitleTracks.findIndex((track) => track.index === subtitle)}
        revision={`${room.mediaGeneration}-${mediaReload}-${room.subsVersion ?? 0}-${subtitleCount}`}
      />
      {feedback ? <span key={feedback.id} className="player-feedback" aria-hidden="true">{feedback.node}</span> : null}
      {unplayable ? (
        <div className="player-unplayable" role="alert">
          <p>{t(unplayable.cause === 'codec' ? 'room.unplayable' : 'room.playbackFailed')}</p>
          <CopyErrorReport room={room} failure={`playback: ${unplayable.reason}`} detail={lastUploadFailureDetail()} t={t} />
        </div>
      ) : null}
      <div className="player-controls" ref={controlsRef}>
        {/* The scrubber owns the full width of the bar; everything that acts on
            what it points at sits underneath it. */}
        <div
          className="seek-control"
          // The bar's rect is read once on entry rather than on every move:
          // getBoundingClientRect is a forced layout, and the bar cannot
          // change size while a pointer is travelling across it.
          onPointerEnter={(event) => { hoverRectRef.current = event.currentTarget.getBoundingClientRect() }}
          onPointerMove={(event) => {
            // A finger is not a hover: on touch the only pointermove is the
            // drag itself, and with no pointerout coming the label would
            // stay pinned wherever the drag ended.
            if (event.pointerType === 'touch') return
            const rect = hoverRectRef.current ?? event.currentTarget.getBoundingClientRect()
            hoverRectRef.current = rect
            if (rect.width <= 0) return
            const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
            const seconds = frac * seekMax
            const index = chapterIndexAt(seconds)
            // The section under the pointer and the time the pointer is at —
            // what a click would seek to — not the chapter's own span.
            const text = index >= 0
              ? `${chapterLabel(index)} · ${formatTime(seconds)}`
              : formatTime(seconds)
            const leftPct = Math.min(Math.max(frac * 100, 6), 94)
            // A pointer reports 100+ moves a second and the label is a whole
            // second wide: rendering every one of them re-renders the player
            // to redraw the same tooltip in the same place.
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
            value={Math.min(scrubSec ?? pendingSeekSec ?? shownSec, seekMax)}
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

// The ranges are rebuilt from the element several times a second and are
// almost always the same ones; handing React a new array every time meant a
// full player render for a scrub bar that did not move. This keeps the old
// array whenever nothing actually changed, so the render bails out.
function keepRanges(next: BufferedRange[]): (prev: BufferedRange[]) => BufferedRange[] {
  return (prev) => (
    prev.length === next.length && prev.every((range, index) => range.start === next[index].start && range.end === next[index].end)
      ? prev
      : next
  )
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
