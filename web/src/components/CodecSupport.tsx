import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Button } from '../ui/Button'
import { Dialog, DialogContent } from '../ui/Dialog'
import { detectCodecSupport, dismissalRecord, dismissedCodecs, unacknowledgedCodecs, type CodecID } from '../codecs'
import './codecSupport.css'

const DISMISSED_KEY = 'ss.codec-notice.v1'

const USE_KEYS: Record<CodecID, string> = {
  h264: 'codec.h264Use',
  hevc: 'codec.hevcUse',
  av1: 'codec.av1Use',
  vp9: 'codec.vp9Use',
}

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Raised only when a codec is genuinely missing, and at most once per codec:
 * a codec regained is never announced, and one already dismissed stays so.
 */
export function CodecSupportNotice() {
  const t = useT()
  const [support] = useState(detectCodecSupport)
  const [open, setOpen] = useState(
    () => unacknowledgedCodecs(support, dismissedCodecs(readDismissed())).length > 0,
  )

  const dismiss = () => {
    setOpen(false)
    try {
      localStorage.setItem(DISMISSED_KEY, dismissalRecord(readDismissed(), support))
    } catch {}
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss() }}>
      {open ? (
        <DialogContent
          className="codec-dialog"
          closeLabel={t('home.closeDialog')}
          title={t('codec.title')}
          description={t('codec.guide')}
          onCloseClick={dismiss}
        >
          <div className="codec-unfold">
            <div>
              <ul className="codec-list">
                {support.map((codec) => (
                  <li key={codec.id} className={`codec-row ${codec.supported ? '' : 'is-unsupported'}`}>
                    <span className="codec-name">
                      <strong>{codec.label}</strong>
                      <span>{t(USE_KEYS[codec.id])}</span>
                    </span>
                    <span className="codec-state">
                      {codec.supported
                        ? <Check size={12} aria-hidden="true" />
                        : <X size={12} aria-hidden="true" />}
                      {t(codec.supported ? 'codec.supported' : 'codec.unsupported')}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="codec-advice">{t('codec.advice')}</p>
              <div className="codec-actions">
                <Button variant="primary" onClick={dismiss}>{t('codec.dismiss')}</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
