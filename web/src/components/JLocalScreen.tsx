import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN } from '../jlocal/status'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Dropdown } from '../catalog/Dropdown'
import './jlocalScreen.css'

/**
 * Live thumbnail of what the app sees. Polls /capture/preview.jpg once a
 * second while the cached caps advertise capture, and hides itself on the
 * first 404 — the app answers 404 while idle, so no preview exists yet.
 * The pane holds a 16:9 box; without a frame there is no box at all.
 */
function JLocalPreview() {
  const allowed = getCachedJLocalCapabilities()?.screen.capture === true
  const [frame, setFrame] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!allowed || failed) return
    const timer = window.setInterval(() => setFrame((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [allowed, failed])
  if (!allowed || failed) return null
  return (
    <div className="jscreen-preview-pane">
      <img
        alt=""
        className="jscreen-preview"
        key={frame}
        src={`${JLOCAL_ORIGIN}/capture/preview.jpg`}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

interface JLocalCaptureTarget {
  id: string
  name: string
  width: number
  height: number
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
    const { id, name, width, height } = entry as Record<string, unknown>
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue
    if (typeof width !== 'number' || typeof height !== 'number') continue
    targets.push({ id: String(id), name, width, height })
  }
  return targets
}

export interface JLocalScreenModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseBrowser: () => void
  onConfirm: (stream: MediaStream, stop: () => void) => void
}

/**
 * The companion-app path for screen sharing. It only ever opens when the
 * capability gate already saw screen.capture, so the cached caps are read
 * synchronously for the quality ceilings.
 *
 * Two tabs share one confirm path: Displays lists GET /capture/displays on
 * open as a scroll row of cards with the live preview under it; Apps lists
 * GET /capture/windows on first open as single-pick rows. Confirming hands
 * the feed's MediaStream to the parent, which publishes it through the
 * existing browser pipeline.
 */
export function JLocalScreenModal({ open, onOpenChange, onUseBrowser, onConfirm }: JLocalScreenModalProps) {
  const t = useT()
  const caps = getCachedJLocalCapabilities()
  const resolutions = (() => {
    const allowed = RESOLUTIONS.filter(
      (option) => option.width <= (caps?.screen.maxWidth ?? 1920) && option.height <= (caps?.screen.maxHeight ?? 1080),
    )
    return allowed.length > 0 ? allowed : [RESOLUTIONS[0] as (typeof RESOLUTIONS)[number]]
  })()
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
  const [startFailed, setStartFailed] = useState(false)

  useEffect(() => {
    if (!open) {
      setTab('displays')
      setDisplays(null)
      setDisplaysFailed(false)
      setDisplayId(null)
      setWindows(null)
      setWindowsFailed(false)
      setWindowsLoaded(false)
      setWindowId(null)
      setStartFailed(false)
      return
    }
    let cancelled = false
    setDisplays(null)
    setDisplaysFailed(false)
    setDisplayId(null)
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
  }, [open])

  // The window list loads once, the first time the Apps tab opens — switching
  // back and forth must not refetch.
  useEffect(() => {
    if (!open || tab !== 'windows' || windowsLoaded) return
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
  }, [open, tab, windowsLoaded])

  const canPickDisplay = !displaysFailed && displays !== null && displays.length > 0 && displayId !== null
  const canPickWindow = windowsLoaded && !windowsFailed && windows !== null && windows.length > 0 && windowId !== null
  const canConfirm = tab === 'displays' ? canPickDisplay : canPickWindow

  const confirm = () => {
    const picked = resolutions.find((option) => option.id === resolution) ?? resolutions[0]
    if (!picked || starting) return
    const target = tab === 'windows'
      ? (windowId !== null ? { kind: 'window' as const, id: windowId } : null)
      : (displayId !== null ? { kind: 'display' as const, id: displayId } : null)
    if (!target) return
    setStarting(true)
    setStartFailed(false)
    void startJLocalScreenFeed(target, { width: picked.width, height: picked.height, fps })
      .then(({ stream, stop }) => {
        onConfirm(stream, stop)
        onOpenChange(false)
      })
      .catch(() => setStartFailed(true))
      .finally(() => setStarting(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="jscreen-dialog"
        title={t('jlocal.screenTitle')}
        description={t('jlocal.screenGuide')}
        closeLabel={t('jlocal.close')}
      >
        <div className="jscreen-tabs" role="tablist" aria-label={t('jlocal.screenTitle')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'displays'}
            onClick={() => setTab('displays')}
          >
            {t('jlocal.screenTabDisplays')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'windows'}
            onClick={() => setTab('windows')}
          >
            {t('jlocal.screenTabApps')}
          </button>
        </div>
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
            {canPickDisplay ? <JLocalPreview /> : null}
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
                    <span>{window.name}</span>
                    <small>{window.width}×{window.height}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        {canConfirm ? (
          <div className="jscreen-grid">
            <div className="jscreen-field">
              <span>{t('jlocal.screenRes')}</span>
              <Dropdown
                label={t('jlocal.screenRes')}
                value={resolution}
                options={resolutions.map((option) => ({ value: option.id, label: option.id }))}
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
        {startFailed ? <p className="jscreen-error" role="alert">{t('jlocal.screenStartError')}</p> : null}
        <div className="jscreen-actions">
          {canConfirm ? (
            <button type="button" className="primary-button" disabled={starting} onClick={confirm}>
              {t('jlocal.screenStart')}
            </button>
          ) : null}
          <Button variant="ghost" onClick={onUseBrowser}>{t('jlocal.screenUseBrowser')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
