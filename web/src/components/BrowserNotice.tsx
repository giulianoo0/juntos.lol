import { useState } from 'react'
import { X } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { isUnsupportedBrowser } from '../browser'

const DISMISS_KEY = 'ss.browser-notice.v1'

export function BrowserNotice({ t }: { t: Translator }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed || !isUnsupportedBrowser()) return null

  return (
    <div className="browser-notice" role="status">
      <span>{t('browser.unsupported')}</span>
      <button
        type="button"
        aria-label={t('browser.dismiss')}
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, '1')
          } catch {
            // A blocked storage should still let the notice be closed.
          }
          setDismissed(true)
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
