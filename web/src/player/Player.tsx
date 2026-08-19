import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  FastForward, Lock, Maximize, Minimize, Pause, Play, Rewind,
  SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from 'lucide-react'
import type Hls from 'hls.js'
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import type { PlayState, RoomInfo } from '../types'
import type { Translator } from '../i18n/useT'
import { expectedPositionMs } from './position'
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
}

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

export function Player({ room, isController, videoRef, send, t, syncState, serverOffsetMs = 0 }: PlayerProps) {
  const { toast } = useToast()
  // Says why a control did nothing, at the moment it is used. The standing
  // note this replaces sat in the bar for the whole session, explaining
  // something nobody had tried yet.
  const refuseControl = useCallback(() => toast(t('room.controllerOnly')), [t, toast])
  const playerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playRequestedRef = useRef(false)
  const playAttemptRef = useRef(false)
  const controlsTimerRef = useRef<number | null>(null)
  const feedbackSeqRef = useRef(0)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>([])
  // The picture sizes this source was published in, and which one this viewer
  // is watching. -1 is hls.js's "pick for me". The choice is deliberately per
  // person: everyone in a room has a different connection, and picking a
  // quality for the group would just move the stalling to whoever has least.
  const [levels, setLevels] = useState<Array<{ height: number; bitrate: number }>>([])
  const [level, setLevel] = useState(-1)
  const [subtitle, setSubtitle] = useState(-1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
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
    const source = `/media/${encodeURIComponent(room.id)}/hls/master.m3u8?g=${generation}&v=${room.mediaVersion ?? 0}`
    let disposed = false
    setUnplayable(false)
    recoveriesRef.current = 0
    // A republish of the same recording resumes where this player was; only a
    // different recording starts over from its beginning.
    const startPosition = resumeRef.current.generation === generation ? resumeRef.current.time : 0

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
      if (video.paused || advanced <= 0) return
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
        hls.on(HlsClass.Events.MEDIA_ATTACHED, () => hls.loadSource(source))
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
      resumeRef.current = { generation, time: video.currentTime }
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, room.mediaGeneration, room.mediaVersion, videoRef])

  // Subtitle modes are driven from state instead of the <select> handler so
  // the choice survives everything that reloads cues: a subsVersion bump
  // republishing the .vtt files under the same names (a growing extraction),
  // a media republish remounting hls.js, and any per-browser mode reset that
  // comes with a <track> src change. Only the first subtitleCount text tracks
  // belong to this component; hls.js may append its own after them.
  const subtitleCount = (room.subtitleTracks ?? []).length
  useEffect(() => {
    const tracks = videoRef.current?.textTracks
    if (!tracks) return
    for (let index = 0; index < Math.min(tracks.length, subtitleCount); index += 1) {
      tracks[index].mode = index === subtitle ? 'showing' : subtitle === -1 ? 'disabled' : 'hidden'
    }
  }, [subtitle, subtitleCount, room.subsVersion, room.mediaGeneration, room.mediaVersion, videoRef])

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
          positionMs: Math.round(video.currentTime * 1000),
          rate: video.playbackRate,
        })
      }
    }).catch(() => {
      // A click can land while hls.js is still attaching the MediaSource.
      // Keep the intent and retry from the next canplay event.
      playAttemptRef.current = false
    })
  }, [isController, send, videoRef])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Calling play inside the gesture preserves browser user activation. A
      // WebSocket round trip first would make browsers reject audible autoplay.
      playRequestedRef.current = true
      attemptPlay()
      return
    }
    // Starting playback stays open to everyone: a viewer whose browser
    // refused to autoplay has no other way in, and the sync corrects the
    // position immediately. Stopping it is the controller's alone.
    if (!isController) {
      refuseControl()
      return
    }
    playRequestedRef.current = false
    video.pause()
    send('pause', {
      positionMs: Math.round(video.currentTime * 1000),
      rate: video.playbackRate,
    })
  }, [attemptPlay, isController, refuseControl, send, videoRef])

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    send('seek', { positionMs: Math.round(seconds * 1000) })
  }, [isController, send, videoRef])

  // A viewer catching up moves only itself: never a room-wide command.
  const goLive = useCallback(() => {
    const video = videoRef.current
    if (!video || !syncState) return
    const expected = expectedPositionMs(syncState, Date.now() + serverOffsetMs)
    if (Math.abs(video.currentTime * 1000 - expected) <= LIVE_SYNC_THRESHOLD_MS) return
    video.currentTime = expected / 1000
  }, [serverOffsetMs, syncState, videoRef])

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
    // An event playlist reports no duration until it has grown, so an unknown
    // length must not become a zero ceiling: that would clamp every rewind to
    // a negative position, which the server rejects outright.
    const ceiling = duration > 0 ? duration : Number.POSITIVE_INFINITY
    seek(Math.min(Math.max(video.currentTime + delta, 0), ceiling))
    return true
  }, [duration, isController, refuseControl, seek, videoRef])

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
  // into a field, or aimed at a focused control, is left alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

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
          togglePlay()
          showFeedback(video?.paused ? <Play size={26} /> : <Pause size={26} />)
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
          const target = event.key === 'Home' ? 0 : Math.max(duration - 1, 0)
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
  }, [applyVolume, duration, isController, revealControls, seek, seekBy, showFeedback, toggleFullscreen, toggleMute, togglePlay, videoRef])

  const muteLabel = t(muted || volume === 0 ? 'room.unmute' : 'room.mute')
  const fullscreenLabel = t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')
  const playLabel = t(playing ? 'room.pause' : 'room.play')

  const seekMax = Math.max(duration, 1)
  const pct = (seconds: number) => `${(Math.min(Math.max(seconds, 0), seekMax) / seekMax) * 100}%`
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
      onDoubleClick={(event) => {
        // Ignore double clicks aimed at the control bar, where they would
        // otherwise fullscreen the player while someone is dragging a slider.
        if ((event.target as HTMLElement).closest('.player-controls')) return
        toggleFullscreen()
      }}
    >
      {loading ? (
        <div className="player-loading" role="status" aria-live="polite">
          <span className="player-spinner" aria-hidden="true" />
          <span className="sr-only">{t('status.buffering')}</span>
        </div>
      ) : null}
      <video
        ref={videoRef}
        className="video"
        playsInline
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
          setCurrentTime(event.currentTarget.currentTime)
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(readBufferedRanges(event.currentTarget))
        }}
        onDurationChange={(event) => setDuration(playableDuration(event.currentTarget))}
        onLoadedMetadata={(event) => setDuration(playableDuration(event.currentTarget))}
        onProgress={(event) => {
          setDuration(playableDuration(event.currentTarget))
          setBufferedRanges(readBufferedRanges(event.currentTarget))
        }}
      >
        {(room.subtitleTracks ?? []).map((track, index) => (
          <track
            key={`${track.index}-${track.language}`}
            kind="subtitles"
            src={`/media/${encodeURIComponent(room.id)}/subs/sub_${index}_${safeLanguage(track.language)}.vtt?g=${room.mediaGeneration}&s=${room.subsVersion ?? 0}`}
            srcLang={track.language || 'und'}
            label={track.title || track.language || `Subtitle ${index + 1}`}
          />
        ))}
      </video>
      {feedback ? <span key={feedback.id} className="player-feedback" aria-hidden="true">{feedback.node}</span> : null}
      {unplayable ? <div className="player-unplayable" role="alert">{t('room.unplayable')}</div> : null}
      <div className="player-controls raised">
        <button
          aria-label={playLabel}
          title={`${playLabel} (Space)`}
          onClick={togglePlay}
          onPointerUp={(event) => event.currentTarget.blur()}
        >{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
        <div className="seek-control">
          <div className="seek-track" aria-hidden="true">
            <div className="seek-played" style={{ width: pct(currentTime) }} />
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
          </div>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={seekMax}
            value={Math.min(currentTime, seekMax)}
            disabled={!isController}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </div>
        <span className="timecode">{formatTime(currentTime)} / {formatTime(duration)}</span>
        {expectedMs !== null ? (
          <button
            className={`live-button ${atLiveEdge ? 'is-live' : ''}`}
            title={t(atLiveEdge ? 'room.liveInSync' : 'room.liveBehind')}
            onClick={goLive}
          >LIVE</button>
        ) : null}
        {levels.length > 1 ? (
          <label>{t('room.quality')}
            <select
              value={level}
              onChange={(event) => {
                const next = Number(event.target.value)
                setLevel(next)
                if (hlsRef.current) hlsRef.current.currentLevel = next
              }}
            >
              <option value={-1}>{t('room.qualityAuto')}</option>
              {levels.map((entry, index) => (
                <option key={`${entry.height}-${index}`} value={index}>
                  {entry.height ? `${entry.height}p` : `${Math.round(entry.bitrate / 1000)} kbps`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {audioTracks.length > 1 ? (
          <label>{t('room.audio')}
            <select onChange={(event) => { if (hlsRef.current) hlsRef.current.audioTrack = Number(event.target.value) }}>
              {audioTracks.map((track, index) => <option key={`${track.name}-${index}`} value={index}>{track.name || track.lang || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        {(room.subtitleTracks?.length ?? 0) > 0 ? (
          <label>{t('room.subtitles')}
            <select value={subtitle} onChange={(event) => setSubtitle(Number(event.target.value))}>
              <option value={-1}>{t('room.off')}</option>
              {(room.subtitleTracks ?? []).map((track, index) => <option key={track.index} value={index}>{track.title || track.language || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        <div className="volume-control">
          <button
            className="volume-button"
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
          className="fullscreen-button"
          aria-label={fullscreenLabel}
          title={`${fullscreenLabel} (F)`}
          onClick={toggleFullscreen}
        >{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
      </div>
      {room.bitmapSubsSkipped > 0 ? <span className="notice-chip">{t('room.bitmapSkipped')}</span> : null}
    </div>
  )
}

// Keystrokes meant for a text field or an already focused control must never
// be stolen by the player. Space activates buttons and links, and both arrow
// keys drive range inputs and selects natively.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'OPTION'].includes(target.tagName)
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
