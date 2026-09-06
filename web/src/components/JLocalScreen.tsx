import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN } from '../jlocal/status'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import './jlocalScreen.css'

/**
 * Live thumbnail of what the app sees. Polls /capture/preview.jpg once a
 * second while the cached caps advertise capture, and hides itself on the
 * first 404 — the app answers 404 while idle, so no preview exists yet.
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
    <img
      alt=""
      className="jscreen-preview"
      key={frame}
      src={`${JLOCAL_ORIGIN}/capture/preview.jpg`}
      onError={() => setFailed(true)}
    />
  )
}

interface JLocalDisplay {
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

const FRAME_RATES = [30, 60] as const

/** Whatever GET /capture/displays answers, a usable list or nothing. Never throws. */
function parseDisplays(body: unknown): JLocalDisplay[] {
  if (!Array.isArray(body)) return []
  const displays: JLocalDisplay[] = []
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, width, height } = entry as Record<string, unknown>
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue
    if (typeof width !== 'number' || typeof height !== 'number') continue
    displays.push({ id: String(id), name, width, height })
  }
  return displays
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
 * synchronously for the quality ceilings. The display list comes from
 * GET /capture/displays on open; confirming hands the feed's MediaStream to
 * the parent, which publishes it through the existing browser pipeline.
 * Video-only v1: no audio track comes from the app.
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
  const [displays, setDisplays] = useState<JLocalDisplay[] | null>(null)
  const [displaysFailed, setDisplaysFailed] = useState(false)
  const [displayId, setDisplayId] = useState<string | null>(null)
  const [resolution, setResolution] = useState<string>(resolutions[resolutions.length - 1]?.id ?? '1080p')
  const [fps, setFps] = useState<number>(frameRates[0] ?? 30)
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)

  useEffect(() => {
    if (!open) {
      setDisplays(null)
      setDisplaysFailed(false)
      setDisplayId(null)
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
        const found = parseDisplays(await response.json())
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

  const canPick = !displaysFailed && displays !== null && displays.length > 0 && displayId !== null

  const confirm = () => {
    const picked = resolutions.find((option) => option.id === resolution) ?? resolutions[0]
    if (!picked || displayId === null || starting) return
    setStarting(true)
    setStartFailed(false)
    void startJLocalScreenFeed(displayId, { width: picked.width, height: picked.height, fps })
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
        {displays === null && !displaysFailed ? (
          <div className="jscreen-note" role="status">
            <p>{t('jlocal.screenDisplayLoading')}</p>
          </div>
        ) : null}
        {displaysFailed ? <p className="jscreen-error" role="alert">{t('jlocal.screenDisplayError')}</p> : null}
        {displays !== null && !displaysFailed && displays.length === 0 ? (
          <p className="jscreen-error" role="alert">{t('jlocal.screenDisplayEmpty')}</p>
        ) : null}
        {canPick ? (
          <label className="jscreen-field">
            <span>{t('jlocal.screenDisplay')}</span>
            <select value={displayId ?? ''} onChange={(event) => setDisplayId(event.target.value)}>
              {displays?.map((display) => (
                <option key={display.id} value={display.id}>
                  {display.name} · {display.width}×{display.height}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {canPick ? (
          <div className="jscreen-grid">
            <label className="jscreen-field">
              <span>{t('jlocal.screenRes')}</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                {resolutions.map((option) => (
                  <option key={option.id} value={option.id}>{option.id}</option>
                ))}
              </select>
            </label>
            <label className="jscreen-field">
              <span>{t('jlocal.screenFps')}</span>
              <select value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                {frameRates.map((rate) => (
                  <option key={rate} value={rate}>{rate}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {canPick ? (
          <div className="jscreen-note" role="note">
            <p>{t('jlocal.screenAudioNote')}</p>
          </div>
        ) : null}
        <JLocalPreview />
        {startFailed ? <p className="jscreen-error" role="alert">{t('jlocal.screenStartError')}</p> : null}
        <div className="jscreen-actions">
          {canPick ? (
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
