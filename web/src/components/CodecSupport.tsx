import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Button } from '../ui/Button'
import { Dialog, DialogContent } from '../ui/Dialog'
import { detectCodecSupport, dismissalRecord, dismissedCodecs, unacknowledgedCodecs, type CodecID } from '../codecs'
import './codecSupport.css'

// Remembers which codecs were reported, not merely that something was. A
// browser that later refuses one it used to play is worth saying once; one
// that starts playing a codec again is not worth saying anything at all.
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
 * Tells a viewer what their browser cannot decode, before a room does it for
 * them by never starting.
 *
 * The pipeline copies H.264, HEVC and AV1 through untouched, so which of those
 * a browser handles decides whether a given room plays at all. Meeting that as
 * a spinner that never resolves reads as the app being broken; meeting it as a
 * list reads as a fact about the browser.
 *
 * Only ever raised when something is genuinely missing, and at most once per
 * codec — a viewer whose browser plays everything never sees it, and one who
 * has read about HEVC does not read about it again because Chrome spent a
 * session without its hardware decoder.
 */
export function CodecSupportNotice() {
  const t = useT()
  // Probed once on mount: the answer cannot change while the page is open.
  const [support] = useState(detectCodecSupport)
  const [open, setOpen] = useState(
    () => unacknowledgedCodecs(support, dismissedCodecs(readDismissed())).length > 0,
  )

  const dismiss = () => {
    setOpen(false)
    try {
      // Read again rather than reuse what mount saw: another tab may have
      // dismissed a codec since, and losing that would warn about it twice.
      localStorage.setItem(DISMISSED_KEY, dismissalRecord(readDismissed(), support))
    } catch {
      // A browser refusing storage costs a repeat warning, not a broken page.
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss() }}>
      {open ? (
        <DialogContent
          className="codec-dialog"
          // Its own name: sharing the button's would leave two controls
          // announced identically, and a screen reader user with no way to
          // tell which one they were on.
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
