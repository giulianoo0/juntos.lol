import { forwardRef, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Check, Gauge, MonitorOff, MonitorUp, Replace, Users, Volume2, VolumeX } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import type { ScreenShareInfo } from '../types'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { MorphingMenu } from '../ui/MorphingMenu'
import { MORPH_EASE } from '../ui/morphTokens'
import { playJoinChime } from '../ui/chime'
import { useToast } from '../ui/toastContext'
import { SCREEN_QUALITIES, screenQuality, type ScreenQualityId, type ScreenSendStats } from '../screenshare'
import { useScreenShare, type JlocalPick, type ScreenTile } from './useScreenShare'
import { Dialog, DialogContent } from '../ui/Dialog'
import { isJLocalCaptureAvailable } from '../jlocal/capabilities'
import { JlocalPicker } from './JlocalPicker'
import { SoundMenu } from './SoundMenu'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'

/** Columns that keep every tile as close to a screen's own shape as possible. */
function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  return 3
}

/** A tile arrives a touch smaller and settles; the grid reflows on a slightly longer clock so the two read as one move. */
const TILE_DURATION = 0.32
const REFLOW_DURATION = 0.42

function formatStats(stats: ScreenSendStats): string {
  const mbps = stats.bitrate / 1_000_000
  return `${stats.width}×${stats.height} · ${Math.round(stats.frameRate)} fps · ${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mb/s`
}

/**
 * The screen room's stage: one tile per live screen in a grid that reflows
 * as people start and stop, a click on any tile to give it the floor, and a
 * bar of controls that keeps out of the way until the pointer comes near.
 * Every decision about publishing and subscribing lives in the hook; this is
 * only how it looks.
 */
export function ScreenStage({ roomId, memberId, nickname, capability, isController, shareOpen, screens, t }: {
  roomId: string
  memberId: string
  nickname: string
  capability: string
  isController: boolean
  shareOpen: boolean
  screens: ScreenShareInfo[]
  t: Translator
}) {
  const { toast } = useToast()
  const previewRef = useRef<HTMLVideoElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Whether the open picker starts a share or swaps the surface of the live one. */
  const [pickerMode, setPickerMode] = useState<'start' | 'switch'>('start')
  const [pickerError, setPickerError] = useState<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const share = useScreenShare({
    roomId,
    memberId,
    nickname,
    capability,
    isController,
    shareOpen,
    screens,
    onScreenStarted: (started) => {
      toast(<span><strong>{started.nickname}</strong> {t('room.screenStarted')}</span>)
      playJoinChime()
    },
  })

  useEffect(() => {
    const preview = previewRef.current
    if (preview) preview.srcObject = share.preview
  }, [share.preview])

  useEffect(() => {
    if (!share.error) return
    toast(t(share.error === 'closed' ? 'room.screenClosedNotice' : share.error === 'full' ? 'room.screenFull' : 'error.screenshare'))
  }, [share.error, toast, t])

  const tiles = share.screens
  const focused = focusedId !== null && tiles.length > 1 && tiles.some((tile) => tile.memberId === focusedId) ? focusedId : null

  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setFocusedId(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focused])

  // The companion's picker when the app is up and can capture; the browser's otherwise.
  const beginShare = () => {
    if (isJLocalCaptureAvailable()) { setPickerError(null); setPickerMode('start'); setPickerOpen(true); return }
    share.start()
  }
  // Mid-share, the same choice again: the companion's picker or the browser's.
  const switchShare = () => {
    if (isJLocalCaptureAvailable()) { setPickerError(null); setPickerMode('switch'); setPickerOpen(true); return }
    share.switchSource()
  }
  const pickJlocal = (pick: JlocalPick) => {
    setPickerError(null)
    const attempt = pickerMode === 'switch' ? share.switchJlocal(pick) : share.startWithJlocal(pick)
    attempt
      .then(() => setPickerOpen(false))
      .catch((failure: unknown) => {
        const message = failure instanceof Error ? failure.message : ''
        setPickerError(t(message.includes('permission') ? 'jlocal.permission' : message === 'sharing_closed' ? 'room.screenClosedNotice' : 'jlocal.failed'))
      })
  }

  const toggleFocus = useCallback((id: string) => {
    setFocusedId((current) => (current === id ? null : id))
  }, [])

  const sharing = share.state === 'sharing' || share.state === 'starting'
  const canPublish = share.supported && share.mayPublish && !share.full
  const hasRemote = tiles.some((tile) => !tile.self)
  const hint = !share.supported ? t('room.screenUnsupported')
    : share.full ? t('room.screenFull')
    : canPublish ? t('room.screenHostHint')
    : t('room.screenWaiting')

  const tileTransition = reducedMotion
    ? { duration: 0 }
    : { duration: TILE_DURATION, ease: MORPH_EASE, layout: { duration: REFLOW_DURATION, ease: MORPH_EASE } }

  const controls = (
    <>
      {canPublish ? (
        sharing
          ? (
            <>
              <Button className="screen-stop" disabled={!memberId} onClick={share.stop}>
                <MonitorOff size={15} aria-hidden="true" />{t('room.screenStop')}
              </Button>
              <IconButton icon={<Replace size={16} />} label={t('room.screenSwitch')} disabled={share.state !== 'sharing'} onClick={switchShare} />
            </>
          ) : (
            <Button variant="primary" disabled={!memberId} onClick={beginShare}>
              <MonitorUp size={15} aria-hidden="true" />{t('room.screenStart')}
            </Button>
          )
      ) : null}
      {canPublish && !share.viaJlocal ? (
        <QualityMenu quality={share.quality} onPick={share.setQuality} t={t} />
      ) : null}
      {sharing && share.viaJlocal && getCachedJLocalCapabilities()?.audio.capture ? <SoundMenu t={t} /> : null}
      {sharing && share.stats ? <span className="screen-stats">{formatStats(share.stats)}</span> : null}
      {hasRemote || isController ? <span className="screen-bar-sep" aria-hidden="true" /> : null}
      {hasRemote ? (
        <IconButton
          icon={share.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          label={t(share.muted ? 'room.screenUnmute' : 'room.screenMute')}
          aria-pressed={share.muted}
          onClick={() => share.setMuted(!share.muted)}
        />
      ) : null}
      {isController ? (
        <IconButton
          icon={<Users size={16} />}
          label={t(shareOpen ? 'room.screenOpenOn' : 'room.screenOpenOff')}
          className={shareOpen ? 'is-on' : ''}
          aria-pressed={shareOpen}
          onClick={() => { void share.setShareOpen(!shareOpen).catch(() => toast(t('error.screenshare'))) }}
        />
      ) : null}
    </>
  )

  const gridStyle = {
    '--screen-cols': gridColumns(tiles.length),
    '--screen-aside': Math.max(1, tiles.length - 1),
  } as CSSProperties

  return (
    <div className={`player-wrap screen-stage ${tiles.length === 0 ? 'is-empty' : ''}`}>
      <LayoutGroup>
        <div className={`screen-grid ${focused ? 'is-focused' : ''}`} style={gridStyle}>
          <AnimatePresence mode="popLayout">
            {tiles.map((tile) => (
              <Tile
                key={tile.memberId}
                tile={tile}
                previewRef={tile.self && share.preview ? previewRef : undefined}
                canvasRef={tile.self ? (share.preview ? undefined : share.selfCanvasRef) : share.canvasRef(tile.memberId)}
                zoom={tiles.length > 1 ? (focused === tile.memberId ? 'focused' : focused ? 'aside' : 'zoomable') : 'none'}
                transition={tileTransition}
                onToggle={() => toggleFocus(tile.memberId)}
                t={t}
              />
            ))}
          </AnimatePresence>
        </div>
      </LayoutGroup>
      <AnimatePresence>
        {tiles.length === 0 ? (
          <motion.div
            key="empty"
            className="screen-empty"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: MORPH_EASE }}
          >
            <MonitorUp size={30} strokeWidth={1.5} aria-hidden="true" />
            <p>{hint}</p>
            <div className="screen-actions">{controls}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {tiles.length > 0 ? <div className="screen-bar">{controls}</div> : null}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="jpick-dialog" title={t(pickerMode === 'switch' ? 'jlocal.switchTitle' : 'jlocal.pickTitle')} description={t(pickerMode === 'switch' ? 'jlocal.switchGuide' : 'jlocal.pickGuide')} closeLabel={t('home.closeDialog')}>
          {pickerOpen ? (
            <JlocalPicker
              t={t}
              busy={share.state === 'starting'}
              error={pickerError}
              mode={pickerMode}
              onPick={pickJlocal}
              onUseBrowser={() => { setPickerOpen(false); if (pickerMode === 'switch') share.switchSource(); else share.start() }}
              onExit={() => setPickerOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Forwarded so `popLayout` can lift a leaving tile out of the grid's flow. */
const Tile = forwardRef<HTMLDivElement, {
  tile: ScreenTile
  previewRef?: React.RefObject<HTMLVideoElement>
  canvasRef?: (canvas: HTMLCanvasElement | null) => void
  zoom: 'none' | 'zoomable' | 'focused' | 'aside'
  transition: object
  onToggle: () => void
  t: Translator
}>(function Tile({ tile, previewRef, canvasRef, zoom, transition, onToggle, t }, ref) {
  const clickable = zoom !== 'none'
  return (
    <motion.div
      ref={ref}
      layout
      className={`screen-tile ${zoom === 'focused' ? 'is-focused' : zoom === 'aside' ? 'is-aside' : zoom === 'zoomable' ? 'is-zoomable' : ''}`}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={transition}
      onClick={clickable ? onToggle : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } } : undefined}
      aria-label={clickable ? tile.nickname || t('room.screenSomeone') : undefined}
      aria-pressed={clickable ? zoom === 'focused' : undefined}
    >
      <div className="screen-surface">
        {tile.self && previewRef
          ? <video ref={previewRef} autoPlay muted playsInline />
          : <canvas ref={canvasRef} className={tile.stalled ? 'screen-frozen' : ''} role="img" aria-label={tile.nickname || t('room.screenSomeone')} />}
      </div>
      <span className="screen-tile-label">
        {tile.nickname || t('room.screenSomeone')}
        {tile.self ? <em> · {t('room.screenYou')}</em> : null}
      </span>
      {tile.status === 'live' ? null : (
        <span className="screen-tile-state" aria-live="polite">{t(tile.stalled ? 'room.screenStalled' : 'room.screenConnecting')}</span>
      )}
    </motion.div>
  )
})

/** The quality pill: the current preset as the trigger, the list as the morphed panel. */
function QualityMenu({ quality, onPick, t }: {
  quality: ScreenQualityId
  onPick: (id: ScreenQualityId) => void
  t: Translator
}) {
  const label = (id: ScreenQualityId) => (id === 'auto' ? t('room.screenQualityAuto') : screenQuality(id).label)
  return (
    <MorphingMenu
      align="start"
      haspopup="listbox"
      minWidth={0}
      ariaLabel={t('room.screenQuality')}
      triggerClassName="screen-quality-pill"
      trigger={() => <><Gauge size={14} aria-hidden="true" />{label(quality)}</>}
    >
      {(close) => (
        <div className="screen-quality-menu" role="listbox" aria-label={t('room.screenQuality')}>
          {SCREEN_QUALITIES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === quality}
              onClick={() => { close(); onPick(option.id) }}
            >
              {label(option.id)}
              {option.id === quality ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      )}
    </MorphingMenu>
  )
}
