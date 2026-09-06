import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN } from '../jlocal/status'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Dropdown } from '../catalog/Dropdown'
import './jlocalScreen.css'

/**
 * Live snapshot of the picked target. Polls GET
 * /capture/snapshot?display_id=<id>&width=640 (window_id on the Apps tab)
 * every 250ms — 640px is plenty for the ≤320px pane and cheaper to encode.
 * Each frame preloads into an offscreen Image and the visible src only swaps
 * inside its onload, so the current frame never unmounts into a gap; the
 * parent remounts per target via key, restarting poll, shimmer, and denial
 * from scratch. Until the first frame lands the pane shows a 16:9 shimmer
 * skeleton, never a void; a 503 (permission or capture unavailable) swaps
 * the pane for the inline permission hint, while anything else is transient
 * and keeps the shimmer polling. The pane is capped (16:9, 320px) so tall
 * content never balloons the panel.
 */
const PREVIEW_WIDTH = 640
const PREVIEW_POLL_MS = 250

function JLocalPreview({ target }: { target: { kind: 'display' | 'window'; id: string } }) {
  const t = useT()
  const idParam = target.kind === 'window' ? 'window_id' : 'display_id'
  const base = `${JLOCAL_ORIGIN}/capture/snapshot?${idParam}=${encodeURIComponent(target.id)}&width=${PREVIEW_WIDTH}`
  const [src, setSrc] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    let cancelled = false
    let tick = 0
    const poll = () => {
      tick += 1
      const url = `${base}&t=${tick}`
      const probe = new Image()
      probe.onload = () => { if (!cancelled) setSrc(url) }
      probe.onerror = () => {
        if (cancelled) return
        // An <img> hides the status, so probe it: only a 503 (permission
        // or capture unavailable) turns the pane into the hint — anything
        // else is transient and keeps the shimmer polling.
        void fetch(base)
          .then((response) => { if (!cancelled && response.status === 503) setDenied(true) })
          .catch(() => undefined)
      }
      probe.src = url
    }
    poll()
    const timer = window.setInterval(poll, PREVIEW_POLL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [base])
  if (denied) {
    return (
      <div className="jscreen-preview-pane is-denied">
        <p role="alert">{t('jlocal.screenStartError')}</p>
      </div>
    )
  }
  return (
    <div className="jscreen-preview-pane">
      {src === null ? (
        <div className="jscreen-preview-shimmer" role="status" aria-label={t('jlocal.screenDisplayLoading')} />
      ) : (
        <img className="jscreen-preview" src={src} alt="" />
      )}
    </div>
  )
}

interface JLocalCaptureTarget {
  id: string
  name: string
  app: string
  icon: string
  width: number
  height: number
}

/**
 * Letter-avatar for an app row: first letter of the owning app (title
 * fallback) on a deterministic hue, so rows scan like real app icons until
 * the OS exposes true icons.
 */
export function appAvatarHue(app: string): number {
  let hash = 0
  for (let index = 0; index < app.length; index += 1) hash = (hash * 31 + app.charCodeAt(index)) % 360
  return hash
}

export function appAvatarLetter(name: string, app: string): string {
  const source = app.trim().length > 0 ? app : name
  return (Array.from(source.trim())[0] ?? '•').toUpperCase()
}

const RESOLUTIONS = [
  { id: '1080p', width: 1920, height: 1080 },
  { id: '1440p', width: 2560, height: 1440 },
  { id: '4K', width: 3840, height: 2160 },
] as const

const FRAME_RATES = [24, 30, 48, 60] as const

/**
 * Whatever GET /capture/displays or /capture/windows answers, a usable list
 * or nothing. Both wrap the list in an envelope ({displays}/{windows}); a
 * bare array still parses, and numeric ids come back as strings — the web
 * always sends ids back as strings. Never throws.
 */
function parseTargets(body: unknown, key: string): JLocalCaptureTarget[] {
  // The app wraps the list: {displays: [...]} / {windows: [...]}.
  const list = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(list)) return []
  const targets: JLocalCaptureTarget[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, width, height, app, icon } = entry as Record<string, unknown>
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue
    if (typeof width !== 'number' || typeof height !== 'number') continue
    targets.push({
      id: String(id),
      name,
      app: typeof app === 'string' ? app : '',
      icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon : '',
      width,
      height,
    })
  }
  return targets
}

export interface JLocalScreenPanelProps {
  onConfirm: (stream: MediaStream, stop: () => void) => void
  onUseBrowser: () => void
  onExit: () => void
}

/**
 * The companion-app path for screen sharing, as a pure panel: no Dialog, no
 * title, no guide paragraph, no close button. It only ever mounts when the
 * capability gate already saw screen.capture, so the cached caps are read
 * synchronously for the quality ceilings.
 *
 * Two tabs share one confirm path: Displays lists GET /capture/displays on
 * mount as a scroll row of cards with the live preview under it; Apps lists
 * GET /capture/windows on first open as single-pick rows. Confirming hands
 * the feed's MediaStream to the parent, which publishes it through the
 * existing browser pipeline. Escape backs out through onExit — an open
 * dropdown swallows Escape first, so the two never fight.
 */
export function JLocalScreenPanel({ onConfirm, onUseBrowser, onExit }: JLocalScreenPanelProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const caps = getCachedJLocalCapabilities()
  const resolutions = (() => {
    const allowed = RESOLUTIONS.filter(
      (option) => option.width <= (caps?.screen.maxWidth ?? 1920) && option.height <= (caps?.screen.maxHeight ?? 1080),
    )
    return allowed.length > 0 ? allowed : [RESOLUTIONS[0] as (typeof RESOLUTIONS)[number]]
  })()
  // (resolution options are built after the selection state below.)
  const frameRates = (() => {
    const allowed = FRAME_RATES.filter((fps) => fps <= (caps?.screen.maxFps ?? 30))
    return allowed.length > 0 ? allowed : [FRAME_RATES[0] as (typeof FRAME_RATES)[number]]
  })()
  const [tab, setTab] = useState<'displays' | 'windows'>('displays')
  const [displays, setDisplays] = useState<JLocalCaptureTarget[] | null>(null)
  const [displaysFailed, setDisplaysFailed] = useState(false)
  const [displayId, setDisplayId] = useState<string | null>(null)
  const [windows, setWindows] = useState<JLocalCaptureTarget[] | null>(null)
  const [windowsFailed, setWindowsFailed] = useState(false)
  const [windowsLoaded, setWindowsLoaded] = useState(false)
  const [windowId, setWindowId] = useState<string | null>(null)
  const [resolution, setResolution] = useState<string>(resolutions[resolutions.length - 1]?.id ?? '1080p')
  const [fps, setFps] = useState<number>(() => (frameRates.includes(30) ? 30 : frameRates[frameRates.length - 1] ?? 30))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<'permission' | string | null>(null)
  // The default quality must fit the picked target, not the caps ceiling: a
  // 4K default on a 1512x982 display fails the start with a confusing error.
  // The target's exact size always works, so it rides along as a fallback
  // option when no preset fits.
  const selectedTarget =
    tab === 'windows'
      ? (windows?.find((entry) => entry.id === windowId) ?? null)
      : (displays?.find((entry) => entry.id === displayId) ?? null)
  const nativeOption =
    selectedTarget !== null &&
    !resolutions.some(
      (option) => option.width === selectedTarget.width && option.height === selectedTarget.height,
    )
      ? {
          id: `${selectedTarget.width}×${selectedTarget.height}`,
          width: selectedTarget.width,
          height: selectedTarget.height,
        }
      : null
  const resolutionOptions = nativeOption !== null ? [...resolutions, nativeOption] : resolutions
  useEffect(() => {
    if (selectedTarget === null) return
    const fitting = resolutionOptions.filter(
      (option) => option.width <= selectedTarget.width && option.height <= selectedTarget.height,
    )
    const wanted = fitting[fitting.length - 1] ?? nativeOption ?? resolutionOptions[0]
    if (wanted !== undefined) {
      const current = resolutionOptions.find((option) => option.id === resolution)
      const fits =
        current !== undefined &&
        current.width <= selectedTarget.width &&
        current.height <= selectedTarget.height
      if (!fits) setResolution(wanted.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTarget?.id, selectedTarget?.width, selectedTarget?.height, tab])

  const panelRef = useRef<HTMLDivElement>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (panelRef.current && !panelRef.current.contains(event.target as Node | null)) return
      onExitRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${JLOCAL_ORIGIN}/capture/displays`)
        if (!response.ok) throw new Error(`displays ${response.status}`)
        const found = parseTargets(await response.json(), 'displays')
        if (!cancelled) {
          setDisplays(found)
          setDisplayId(found[0]?.id ?? null)
        }
      } catch {
        if (!cancelled) setDisplaysFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // The window list loads once, the first time the Apps tab opens — switching
  // back and forth must not refetch.
  useEffect(() => {
    if (tab !== 'windows' || windowsLoaded) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${JLOCAL_ORIGIN}/capture/windows`)
        if (!response.ok) throw new Error(`windows ${response.status}`)
        const found = parseTargets(await response.json(), 'windows')
        if (!cancelled) {
          setWindows(found)
          setWindowId(found[0]?.id ?? null)
          setWindowsLoaded(true)
        }
      } catch {
        if (!cancelled) {
          setWindowsFailed(true)
          setWindowsLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, windowsLoaded])

  const canPickDisplay = !displaysFailed && displays !== null && displays.length > 0 && displayId !== null
  const canPickWindow = windowsLoaded && !windowsFailed && windows !== null && windows.length > 0 && windowId !== null
  const canConfirm = tab === 'displays' ? canPickDisplay : canPickWindow

  const confirm = () => {
    const picked = resolutionOptions.find((option) => option.id === resolution) ?? resolutionOptions[0]
    if (!picked || starting) return
    const target = tab === 'windows'
      ? (windowId !== null ? { kind: 'window' as const, id: windowId } : null)
      : (displayId !== null ? { kind: 'display' as const, id: displayId } : null)
    if (!target) return
    setStarting(true)
    setStartError(null)
    void startJLocalScreenFeed(target, { width: picked.width, height: picked.height, fps })
      .then(({ stream, stop }) => {
        onConfirm(stream, stop)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : ''
        // Permission denials keep the dedicated hint; any other refusal shows
        // the server's own reason (e.g. size exceeds the display) verbatim.
        setStartError(message.includes('jlocal-capture-permission') ? 'permission' : message.replace(/^jlocal-capture-(failed|unavailable):?\s*/, '') || 'unavailable')
      })
      .finally(() => setStarting(false))
  }

  return (
    <div ref={panelRef} className="jscreen-panel">
      <div className="header-tabs" role="tablist" aria-label={t('jlocal.screenTitle')}>
        {(['displays', 'windows'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'is-active' : ''}
            onClick={() => setTab(value)}
          >
            {tab === value ? (
              <motion.span
                layoutId="jscreen-tab-pill"
                className="season-pill"
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.45, bounce: 0.2 }}
              />
            ) : null}
            <span className="season-tab-label">
              {value === 'displays' ? t('jlocal.screenTabDisplays') : t('jlocal.screenTabApps')}
            </span>
          </button>
        ))}
      </div>
      <div className="jscreen-tabpanel">
      {tab === 'displays' ? (
        <>
          {displays === null && !displaysFailed ? (
            <div className="jscreen-note" role="status">
              <p>{t('jlocal.screenDisplayLoading')}</p>
            </div>
          ) : null}
          {displaysFailed ? <p className="jscreen-error" role="alert">{t('jlocal.screenDisplayError')}</p> : null}
          {displays !== null && !displaysFailed && displays.length === 0 ? (
            <p className="jscreen-error" role="alert">{t('jlocal.screenDisplayEmpty')}</p>
          ) : null}
          {canPickDisplay ? (
            <div className="jscreen-cards" role="radiogroup" aria-label={t('jlocal.screenDisplay')}>
              {displays?.map((display) => (
                <button
                  key={display.id}
                  type="button"
                  role="radio"
                  aria-checked={display.id === displayId}
                  className={`jscreen-card ${display.id === displayId ? 'is-selected' : ''}`}
                  onClick={() => setDisplayId(display.id)}
                >
                  <strong>{display.name}</strong>
                  <small>{display.width}×{display.height}</small>
                </button>
              ))}
            </div>
          ) : null}
          {canPickDisplay && displayId ? (
            <JLocalPreview key={`display-${displayId}`} target={{ kind: 'display', id: displayId }} />
          ) : null}
        </>
      ) : (
        <>
          {windows === null && !windowsFailed ? (
            <div className="jscreen-note" role="status">
              <p>{t('jlocal.screenWindowLoading')}</p>
            </div>
          ) : null}
          {windowsFailed ? <p className="jscreen-error" role="alert">{t('jlocal.screenWindowError')}</p> : null}
          {windows !== null && !windowsFailed && windows.length === 0 ? (
            <p className="jscreen-error" role="alert">{t('jlocal.screenWindowEmpty')}</p>
          ) : null}
          {canPickWindow ? (
            <div className="jscreen-apps" role="radiogroup" aria-label={t('jlocal.screenTabApps')}>
              {windows?.map((window) => (
                <button
                  key={window.id}
                  type="button"
                  role="radio"
                  aria-checked={window.id === windowId}
                  className={`jscreen-app ${window.id === windowId ? 'is-selected' : ''}`}
                  onClick={() => setWindowId(window.id)}
                >
                  {window.icon.length > 0 ? (
                    <img className="jscreen-app-icon is-photo" src={window.icon} alt="" aria-hidden="true" />
                  ) : (
                    <span
                      className="jscreen-app-icon"
                      aria-hidden="true"
                      style={{ ['--app-hue' as string]: String(appAvatarHue(window.app || window.name)) }}
                    >
                      {appAvatarLetter(window.name, window.app)}
                    </span>
                  )}
                  <span className="jscreen-app-label">{window.name}</span>
                  <small>{window.width}×{window.height}</small>
                </button>
              ))}
            </div>
          ) : null}
          {canPickWindow && windowId ? (
            <JLocalPreview key={`window-${windowId}`} target={{ kind: 'window', id: windowId }} />
          ) : null}
        </>
      )}
      </div>
      {canConfirm ? (
        <div className="jscreen-grid">
          <div className="jscreen-field">
            <span>{t('jlocal.screenRes')}</span>
            <Dropdown
              label={t('jlocal.screenRes')}
              value={resolution}
              options={resolutionOptions.map((option) => ({ value: option.id, label: option.id }))}
              onChange={setResolution}
            />
          </div>
          <div className="jscreen-field">
            <span>{t('jlocal.screenFps')}</span>
            <Dropdown
              label={t('jlocal.screenFps')}
              value={String(fps)}
              options={frameRates.map((rate) => ({ value: String(rate), label: `${rate} fps` }))}
              onChange={(value) => setFps(Number(value))}
            />
          </div>
        </div>
      ) : null}
      {startError !== null ? <p className="jscreen-error" role="alert">{startError === 'permission' ? t('jlocal.screenStartError') : startError}</p> : null}
      <div className="jscreen-actions">
        <Button variant="ghost" onClick={onUseBrowser}>{t('jlocal.screenUseBrowser')}</Button>
        {canConfirm ? (
          <button type="button" className="primary-button" disabled={starting} onClick={confirm}>
            {t('jlocal.screenStart')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export interface JLocalScreenModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseBrowser: () => void
  onConfirm: (stream: MediaStream, stop: () => void) => void
}

/**
 * Thin Dialog wrapper around the panel, kept so the room's existing call
 * sites keep working untouched. Home embeds the panel inline instead.
 */
export function JLocalScreenModal({ open, onOpenChange, onUseBrowser, onConfirm }: JLocalScreenModalProps) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="jscreen-dialog"
        title={t('jlocal.screenTitle')}
        description={t('jlocal.screenGuide')}
        closeLabel={t('jlocal.close')}
      >
        {open ? (
          <JLocalScreenPanel onConfirm={(stream, stop) => { onConfirm(stream, stop); onOpenChange(false) }} onUseBrowser={onUseBrowser} onExit={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
