import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type Hls from 'hls.js'
import type { RoomInfo } from '../types'
import type { Translator } from '../i18n/useT'

interface PlayerProps {
  room: RoomInfo
  isController: boolean
  videoRef: MutableRefObject<HTMLVideoElement | null>
  send: (type: string, payload?: Record<string, unknown>) => void
  t: Translator
}

const SEEK_STEP_SECONDS = 5
const SEEK_STEP_LARGE_SECONDS = 10
const VOLUME_STEP = 0.05
// Long enough to read the symbol, short enough that holding an arrow key still
// feels like scrubbing rather than a stack of notifications.
const FEEDBACK_MS = 700

export function Player({ room, isController, videoRef, send, t }: PlayerProps) {
  const playerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playRequestedRef = useRef(false)
  const playAttemptRef = useRef(false)
  const controlsTimerRef = useRef<number | null>(null)
  const feedbackSeqRef = useRef(0)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>([])
  const [subtitle, setSubtitle] = useState(-1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [feedback, setFeedback] = useState<{ id: number; text: string } | null>(null)

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
  const showFeedback = useCallback((text: string) => {
    feedbackSeqRef.current += 1
    setFeedback({ id: feedbackSeqRef.current, text })
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
    const source = `/media/${encodeURIComponent(room.id)}/hls/master.m3u8`
    let disposed = false
    void import('hls.js').then(({ default: HlsClass, ErrorTypes }) => {
      if (disposed) return
      if (HlsClass.isSupported()) {
        // Progressive uploads are EVENT playlists. Native HLS commonly joins
        // those at the live edge and waits for the next uploaded segment;
        // hls.js lets an episode reliably start at its beginning instead.
        const hls = new HlsClass({ startPosition: 0 })
        hlsRef.current = hls
        hls.on(HlsClass.Events.MEDIA_ATTACHED, () => hls.loadSource(source))
        hls.on(HlsClass.Events.MANIFEST_PARSED, () => setAudioTracks(hls.audioTracks))
        hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => setAudioTracks(hls.audioTracks))
        hls.on(HlsClass.Events.ERROR, (_event, data) => {
          if (!data.fatal) return
          if (data.type === ErrorTypes.NETWORK_ERROR) hls.startLoad()
          else if (data.type === ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        })
        hls.attachMedia(video)
        return
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = source
    })
    return () => {
      disposed = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, videoRef])

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
    playRequestedRef.current = false
    video.pause()
    if (isController) {
      send('pause', {
        positionMs: Math.round(video.currentTime * 1000),
        rate: video.playbackRate,
      })
    }
  }, [attemptPlay, isController, send, videoRef])

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    send('seek', { positionMs: Math.round(seconds * 1000) })
  }, [isController, send, videoRef])

  // Relative seeking goes through the same synchronized command as the
  // scrubber, so the controller's own picture moves only once the server has
  // agreed on the position and everyone moves together.
  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return false
    if (!isController) return false
    // An event playlist reports no duration until it has grown, so an unknown
    // length must not become a zero ceiling: that would clamp every rewind to
    // a negative position, which the server rejects outright.
    const ceiling = duration > 0 ? duration : Number.POSITIVE_INFINITY
    seek(Math.min(Math.max(video.currentTime + delta, 0), ceiling))
    return true
  }, [duration, isController, seek, videoRef])

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
          showFeedback(video?.paused ? '▶' : '❚❚')
          return
        case 'ArrowLeft':
        case 'ArrowRight': {
          handled()
          const delta = event.key === 'ArrowLeft' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
          showFeedback(seekBy(delta) ? formatSeekStep(delta) : '🔒')
          return
        }
        case 'j':
        case 'J':
        case 'l':
        case 'L': {
          handled()
          const delta = event.key.toLowerCase() === 'j' ? -SEEK_STEP_LARGE_SECONDS : SEEK_STEP_LARGE_SECONDS
          showFeedback(seekBy(delta) ? formatSeekStep(delta) : '🔒')
          return
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          handled()
          const delta = event.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP
          const base = video?.muted ? 0 : video?.volume ?? 0
          applyVolume(base + delta)
          showFeedback(`${Math.round(Math.min(Math.max(base + delta, 0), 1) * 100)}%`)
          return
        }
        case 'm':
        case 'M':
          handled()
          showFeedback(toggleMute() ? '🔇' : '🔊')
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
            showFeedback(event.key === 'Home' ? '⏮' : '⏭')
          } else showFeedback('🔒')
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
      <video
        ref={videoRef}
        className="video"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onCanPlay={() => attemptPlay()}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime)
          setDuration(playableDuration(event.currentTarget))
        }}
        onDurationChange={(event) => setDuration(playableDuration(event.currentTarget))}
        onLoadedMetadata={(event) => setDuration(playableDuration(event.currentTarget))}
        onProgress={(event) => setDuration(playableDuration(event.currentTarget))}
      >
        {(room.subtitleTracks ?? []).map((track, index) => (
          <track
            key={`${track.index}-${track.language}`}
            kind="subtitles"
            src={`/media/${encodeURIComponent(room.id)}/subs/sub_${index}_${safeLanguage(track.language)}.vtt`}
            srcLang={track.language || 'und'}
            label={track.title || track.language || `Subtitle ${index + 1}`}
          />
        ))}
      </video>
      {feedback ? <span key={feedback.id} className="player-feedback" aria-hidden="true">{feedback.text}</span> : null}
      <div className="player-controls raised">
        <button
          aria-label={playLabel}
          title={`${playLabel} (Space)`}
          onClick={togglePlay}
          onPointerUp={(event) => event.currentTarget.blur()}
        >{playing ? '❚❚' : '▶'}</button>
        <input
          aria-label="Seek"
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          value={Math.min(currentTime, Math.max(duration, 1))}
          disabled={!isController}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="timecode">{formatTime(currentTime)} / {formatTime(duration)}</span>
        <div className="volume-control">
          <button
            className="volume-button"
            aria-label={muteLabel}
            title={`${muteLabel} (M)`}
            onClick={toggleMute}
            onPointerUp={(event) => event.currentTarget.blur()}
          >{volumeIcon(muted ? 0 : volume)}</button>
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
        {audioTracks.length > 1 ? (
          <label>{t('room.audio')}
            <select onChange={(event) => { if (hlsRef.current) hlsRef.current.audioTrack = Number(event.target.value) }}>
              {audioTracks.map((track, index) => <option key={`${track.name}-${index}`} value={index}>{track.name || track.lang || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        {(room.subtitleTracks?.length ?? 0) > 0 ? (
          <label>{t('room.subtitles')}
            <select value={subtitle} onChange={(event) => {
              const next = Number(event.target.value)
              setSubtitle(next)
              const tracks = videoRef.current?.textTracks
              if (tracks) for (let index = 0; index < tracks.length; index += 1) tracks[index].mode = index === next ? 'showing' : 'hidden'
            }}>
              <option value={-1}>{t('room.off')}</option>
              {(room.subtitleTracks ?? []).map((track, index) => <option key={track.index} value={index}>{track.title || track.language || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        <button
          className="fullscreen-button"
          aria-label={fullscreenLabel}
          title={`${fullscreenLabel} (F)`}
          onClick={toggleFullscreen}
        >⛶</button>
        {!isController ? (
          <span className="viewer-note">{t('room.viewer')}</span>
        ) : null}
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

function formatSeekStep(delta: number): string {
  return `${delta > 0 ? '⏩ +' : '⏪ '}${delta}s`
}

function volumeIcon(value: number): string {
  if (value === 0) return '🔇'
  return value < 0.5 ? '🔉' : '🔊'
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
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
