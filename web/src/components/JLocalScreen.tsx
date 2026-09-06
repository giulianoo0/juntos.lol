import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN } from '../jlocal/status'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import './jlocalScreen.css'

/**
 * Live thumbnail of what the app sees. Polls /capture/preview.jpg once a
 * second while the cached caps advertise capture, and hides itself on the
 * first 404 — the app answers 404 while idle, so no preview exists yet.
 */
function JLocalPreview() {
  const allowed = getCachedJLocalCapabilities()?.screen.available === true
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
      key={frame}
      src={`${JLOCAL_ORIGIN}/capture/preview.jpg`}
      onError={() => setFailed(true)}
      style={{ maxWidth: '100%', borderRadius: '12px' }}
    />
  )
}

type AudioMode = 'all' | 'none' | 'custom'

const RESOLUTIONS = [
  { id: '1080p', width: 1920, height: 1080 },
  { id: '1440p', width: 2560, height: 1440 },
  { id: '4K', width: 3840, height: 2160 },
] as const

const FRAME_RATES = [30, 60] as const

/**
 * The companion-app path for screen sharing. It only ever opens when the
 * capability gate already saw screen.available, so the cached caps are read
 * synchronously for the quality ceilings. Phase 1 ends at POST /capture/start
 * expecting 501: the app cannot capture yet, and the modal says so.
 */
export function JLocalScreenModal({ open, onOpenChange, onUseBrowser }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseBrowser: () => void
}) {
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
  const [resolution, setResolution] = useState<string>(resolutions[resolutions.length - 1]?.id ?? '1080p')
  const [fps, setFps] = useState<number>(frameRates[0] ?? 30)
  const [audio, setAudio] = useState<AudioMode>('all')
  const [starting, setStarting] = useState(false)
  const [needUpdate, setNeedUpdate] = useState(false)

  const start = () => {
    const picked = resolutions.find((option) => option.id === resolution) ?? resolutions[0]
    if (!picked) return
    setStarting(true)
    setNeedUpdate(false)
    void fetch(`${JLOCAL_ORIGIN}/capture/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        width: picked.width,
        height: picked.height,
        fps,
        audio: { mode: audio, apps: [] },
        relay: { url: '', path: '', publishToken: '' },
      }),
    }).then((response) => {
      setStarting(false)
      if (response.ok) onOpenChange(false)
      else setNeedUpdate(true)
    }).catch(() => {
      setStarting(false)
      setNeedUpdate(true)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="jscreen-dialog"
        title={t('jlocal.screenTitle')}
        description={t('jlocal.screenGuide')}
        closeLabel={t('jlocal.close')}
      >
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
        <fieldset className="jscreen-audio">
          <label>
            <input type="radio" name="jscreen-audio" checked={audio === 'all'} onChange={() => setAudio('all')} />
            {t('jlocal.screenAudioAll')}
          </label>
          <label>
            <input type="radio" name="jscreen-audio" checked={audio === 'none'} onChange={() => setAudio('none')} />
            {t('jlocal.screenAudioNone')}
          </label>
          <label>
            <input type="radio" name="jscreen-audio" checked={audio === 'custom'} onChange={() => setAudio('custom')} />
            {t('jlocal.screenAudioCustom')}
          </label>
        </fieldset>
        <div className="jscreen-apps" role="status">
          <p>{t('jlocal.screenNoApps')}</p>
        </div>
        <JLocalPreview />
        {needUpdate ? <p className="jscreen-error" role="alert">{t('jlocal.screenNeedUpdate')}</p> : null}
        <div className="jscreen-actions">
          <button type="button" className="primary-button" disabled={starting} onClick={start}>
            {t('jlocal.screenStart')}
          </button>
          <Button variant="ghost" onClick={onUseBrowser}>{t('jlocal.screenUseBrowser')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
