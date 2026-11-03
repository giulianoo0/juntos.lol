import { Captions, Pause, Play, RotateCcw, RotateCw, SlidersHorizontal, MonitorX } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { useT } from '../i18n/useT'
import type { RoomViewModel, Stage } from '../room/model'
import { RoomUiContext, type RoomUi } from '../room/ui/context'
import { Face } from '../room/ui/Face'
import { useRoomStrings } from '../room/ui/strings'
import type { TvKeyAction } from './keys'
import type { MediaAction } from './useRemote'
import styles from './tv.module.css'

/** Where the media is now, for the bar: seconds, and whether it is paused. */
export interface Playhead {
  position: number
  duration: number
  paused: boolean
}

export interface TvRoomKeys {
  key(action: TvKeyAction, repeat: boolean): boolean
  enterUp(): void
  /** A transport key (play, ±10 s) went to the media: show it. */
  flash(action: MediaAction): void
}

const BAR_MS = 4_000
const HOLD_MS = 600
const CHAT_MS = 8_000

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function focusStage(vm: RoomViewModel): Stage | null {
  const spot = vm.spotlight
  if (spot && spot.kind !== 'member') {
    const id = spot.kind === 'screen' ? `screen:${spot.memberId}` : spot.kind
    const found = vm.stages.find((stage) => stage.id === id)
    if (found) return found
  }
  return vm.stages.find((stage) => stage.kind === 'media') ?? vm.stages[0] ?? null
}

/**
 * The room as a TV shows it, made for the remote: the stage fills the
 * screen; OK plays or pauses, ← → skip ten seconds, ↑ ↓ bring up the bar,
 * and OK held opens the sound. The bar hides by itself while it plays.
 */
export function TvRoomView({ vm, playhead, onMedia, onAudio, onTracks, onStop, keysRef }: {
  vm: RoomViewModel
  playhead: () => Playhead | null
  onMedia: (action: MediaAction) => void
  onAudio: () => void
  /** Opens the subtitle and audio picker; absent while there is nothing to pick. */
  onTracks?: () => void
  onStop: () => void
  keysRef: Ref<TvRoomKeys>
}) {
  const t = useT()
  const strings = useRoomStrings()
  const stage = focusStage(vm)
  const [bar, setBar] = useState(false)
  const [osd, setOsd] = useState<{ action: MediaAction; at: number } | null>(null)
  const [head, setHead] = useState<Playhead | null>(null)
  const hideRef = useRef<number | null>(null)
  const holdRef = useRef<number | null>(null)
  const heldRef = useRef(false)
  const barRef = useRef<HTMLDivElement>(null)
  const playRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const tick = () => setHead(playhead())
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [playhead])

  const paused = head?.paused ?? true
  const showBar = useCallback((focusPlay = false) => {
    setBar(true)
    if (hideRef.current !== null) window.clearTimeout(hideRef.current)
    hideRef.current = window.setTimeout(() => setBar(false), BAR_MS)
    if (focusPlay) window.setTimeout(() => playRef.current?.focus(), 0)
  }, [])
  // Paused, the bar stays: there is nothing to watch behind it.
  const visible = bar || (paused && stage?.kind === 'media')
  useEffect(() => () => {
    if (hideRef.current !== null) window.clearTimeout(hideRef.current)
    if (holdRef.current !== null) window.clearTimeout(holdRef.current)
  }, [])

  const flash = useCallback((action: MediaAction) => setOsd({ action, at: Date.now() }), [])
  useEffect(() => {
    if (!osd) return undefined
    const timer = window.setTimeout(() => setOsd(null), 700)
    return () => window.clearTimeout(timer)
  }, [osd])

  const media = useCallback((action: MediaAction) => {
    onMedia(action)
    flash(action === 'playPause' ? (paused ? 'play' : 'pause') : action)
  }, [onMedia, flash, paused])

  useImperativeHandle(keysRef, () => ({
    key(action, repeat) {
      const inBar = barRef.current?.contains(document.activeElement) ?? false
      if (visible && inBar) {
        if (action === 'back') { setBar(false); (document.activeElement as HTMLElement | null)?.blur(); return true }
        showBar()
        return false
      }
      switch (action) {
        case 'enter':
          if (repeat || holdRef.current !== null) return true
          heldRef.current = false
          holdRef.current = window.setTimeout(() => {
            holdRef.current = null
            heldRef.current = true
            onAudio()
          }, HOLD_MS)
          return true
        case 'left':
        case 'right':
          if (stage?.kind !== 'media') { showBar(true); return true }
          media(action === 'left' ? 'rewind' : 'forward')
          showBar()
          return true
        case 'up':
        case 'down':
          showBar(true)
          return true
        default:
          return false
      }
    },
    enterUp() {
      if (holdRef.current === null) return
      window.clearTimeout(holdRef.current)
      holdRef.current = null
      if (heldRef.current) return
      if (stage?.kind === 'media') media('playPause')
      else showBar(true)
    },
    flash,
  }), [visible, showBar, onAudio, stage, media, flash])

  const ui: RoomUi = {
    vm,
    strings,
    pin: null,
    setPin: () => undefined,
    leftSpotlight: false,
    setLeftSpotlight: () => undefined,
    spotlit: null,
    nameOf: (memberId) => vm.people.find((person) => person.id === memberId)?.name ?? '',
    viewProfile: () => undefined,
  }

  const since = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const fresh = vm.chat.filter((message) => message.at >= since.current && now - message.at < CHAT_MS).slice(-3)
  const progress = head && head.duration > 0 ? Math.min(1, head.position / head.duration) : 0

  return (
    <RoomUiContext.Provider value={ui}>
      <div className={styles.room} data-bar={visible || undefined}>
        <main className={styles.roomStage}>
          {stage ? vm.slots.renderStage(stage, 'focus') : (
            <div className={styles.roomPeople}>
              {vm.people.map((person) => (
                <div key={person.id} className={styles.roomPerson} data-speaking={person.speaking || undefined}>
                  <Face id={person.id} avatar={person.avatar} size={168} still={false} />
                  <span>{person.name}</span>
                </div>
              ))}
            </div>
          )}
        </main>

        <header className={styles.roomTop}>
          <h1 className={styles.roomName}>{stage?.title ?? vm.name}</h1>
          <div className={styles.roomFaces}>
            {vm.people.slice(0, 6).map((person) => (
              <span key={person.id} className={styles.roomFace} data-speaking={person.speaking || undefined} title={person.name}>
                <Face id={person.id} avatar={person.avatar} size={44} still />
              </span>
            ))}
            {vm.people.length > 6 ? <span className={styles.roomMore}>+{vm.people.length - 6}</span> : null}
          </div>
        </header>

        {fresh.length > 0 ? (
          <ol className={styles.roomChat} aria-label={strings.chat}>
            {fresh.map((message) => (
              <li key={message.id} data-system={message.system || undefined}>
                {message.system ? null : <strong>{message.author}</strong>}
                <span>{message.text}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {osd ? <Osd key={osd.at} action={osd.action} /> : null}

        <div ref={barRef} className={styles.roomBar} aria-hidden={!visible || undefined}>
          {stage?.kind === 'media' && head ? (
            <div className={styles.roomTime}>
              <span className={styles.roomTrack}>
                <span className={styles.roomPlayed} style={{ transform: `scaleX(${progress})` }} />
                <span className={styles.roomThumb} style={{ left: `${progress * 100}%` }} />
              </span>
              <span className={styles.roomClock}>{clock(head.position)}<span> / {clock(head.duration)}</span></span>
            </div>
          ) : null}
          <div className={styles.roomButtons}>
            {stage?.kind === 'media' ? (
              <>
                <BarButton label={t('tv.back10')} onClick={() => media('rewind')} tabIndex={visible ? 0 : -1}><RotateCcw size={30} /></BarButton>
                <BarButton label={paused ? t('tv.play') : t('tv.pause')} onClick={() => media('playPause')} tabIndex={visible ? 0 : -1} buttonRef={playRef} big>
                  {paused ? <Play size={40} fill="currentColor" /> : <Pause size={40} fill="currentColor" />}
                </BarButton>
                <BarButton label={t('tv.forward10')} onClick={() => media('forward')} tabIndex={visible ? 0 : -1}><RotateCw size={30} /></BarButton>
                <span className={styles.roomDivider} />
              </>
            ) : null}
            {stage?.kind === 'media' && onTracks ? (
              <BarButton label={t('tv.tracks')} onClick={onTracks} tabIndex={visible ? 0 : -1}><Captions size={28} /></BarButton>
            ) : null}
            <BarButton label={t('tv.audio')} onClick={onAudio} tabIndex={visible ? 0 : -1} buttonRef={stage?.kind === 'media' ? undefined : playRef}><SlidersHorizontal size={28} /></BarButton>
            <BarButton label={t('tv.stop')} onClick={onStop} tabIndex={visible ? 0 : -1}><MonitorX size={28} /></BarButton>
          </div>
        </div>
      </div>
    </RoomUiContext.Provider>
  )
}

function BarButton({ label, onClick, children, big, tabIndex, buttonRef }: {
  label: string
  onClick: () => void
  children: ReactNode
  big?: boolean
  tabIndex: number
  buttonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button ref={buttonRef} type="button" className={styles.barButton} data-big={big || undefined} aria-label={label} tabIndex={tabIndex} onClick={onClick}>
      {children}
      <span className={styles.barLabel}>{label}</span>
    </button>
  )
}

function Osd({ action }: { action: MediaAction }) {
  const icon = action === 'rewind' ? <RotateCcw size={56} />
    : action === 'forward' ? <RotateCw size={56} />
    : action === 'pause' ? <Pause size={56} fill="currentColor" />
    : <Play size={56} fill="currentColor" />
  return (
    <div className={styles.osd} aria-hidden="true">
      {icon}
      {action === 'rewind' || action === 'forward' ? <span>10</span> : null}
    </div>
  )
}
