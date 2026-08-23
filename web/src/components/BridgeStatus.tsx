import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { Dialog, DialogContent } from '../ui/Dialog'
import { helperAvailable, resetHelperAvailability } from '../localHelper'
import { playConnect } from '../onboarding/sounds'

// The stable "latest release" asset URLs; GitHub serves them as attachments,
// so the browser downloads straight away without leaving the page.
const ASSET: Record<Os, string> = {
  mac: 'ss-bridge-macos.dmg',
  windows: 'ss-bridge-windows-x86_64.exe',
  linux: 'ss-bridge-linux-x86_64.tar.gz',
}
const OS_LABEL: Record<Os, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' }

type Os = 'mac' | 'windows' | 'linux'

function downloadUrl(os: Os): string {
  return `https://github.com/giulianoo0/ss-bridge/releases/latest/download/${ASSET[os]}`
}

function detectOs(): Os {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Win/i.test(ua)) return 'windows'
  if (/Linux|X11|Android/i.test(ua)) return 'linux'
  return 'mac'
}

/**
 * Header pill for the local helper. It polls continuously, so opening the app
 * flips it to green on its own — with a short chime on the rising edge — without
 * the user clicking anything. A click opens the install dialog.
 */
export function BridgeStatus({ t }: { t: Translator }) {
  const [on, setOn] = useState(false)
  const [open, setOpen] = useState(false)
  const wasOn = useRef(false)

  const os = detectOs()

  const probe = useCallback(async () => {
    resetHelperAvailability()
    const ok = await helperAvailable()
    setOn(ok)
    if (ok && !wasOn.current) { try { playConnect() } catch { /* audio blocked */ } }
    wasOn.current = ok
    return ok
  }, [])

  useEffect(() => {
    let live = true
    const tick = () => { if (live) void probe() }
    tick()
    const timer = window.setInterval(tick, 3_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [probe])

  return (
    <>
      <button
        type="button"
        className={`bridge-status ${on ? 'is-on' : ''}`}
        onClick={() => { setOpen(true); void probe() }}
      >
        <span className="bridge-dot" aria-hidden="true" />
        <span className="nav-label">{on ? t('bridge.on') : t('bridge.off')}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title={t('bridge.title')} description={t('bridge.body')} closeLabel={t('home.closeDialog')}>
            {on ? (
              <p className="bridge-connected">{t('bridge.connected')}</p>
            ) : (
              <>
                <ol className="bridge-steps">
                  <li>{t('bridge.step1')}</li>
                  <li>{t('bridge.step2')}</li>
                  <li>{t('bridge.step3')}</li>
                </ol>
                <a className="primary-button bridge-download" href={downloadUrl(os)}>
                  {t('bridge.download')} · {OS_LABEL[os]}
                </a>
                <div className="bridge-other-os">
                  <span>{t('bridge.otherOs')}</span>
                  {(['mac', 'windows', 'linux'] as Os[]).filter((other) => other !== os).map((other) => (
                    <a key={other} href={downloadUrl(other)}>{OS_LABEL[other]}</a>
                  ))}
                </div>
              </>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  )
}
