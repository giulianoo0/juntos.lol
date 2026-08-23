import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Translator } from '../i18n/useT'
import { Dialog, DialogContent } from '../ui/Dialog'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import {
  helperAvailable,
  localNetworkPermission,
  requestHelperAccess,
  resetHelperAvailability,
  watchLocalNetworkPermission,
} from '../localHelper'
import { playConnect } from '../onboarding/sounds'
import { detectBrowser, detectOs, promptAnchor, type Os } from './platform'

// The stable "latest release" asset URLs; GitHub serves them as attachments,
// so the browser downloads straight away without leaving the page.
const ASSET: Record<Os, string> = {
  mac: 'ss-bridge-macos.dmg',
  windows: 'ss-bridge-windows-setup.exe',
  linux: 'ss-bridge-linux-x86_64.tar.gz',
}
const OS_LABEL: Record<Os, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' }

// What the dialog is showing. 'connected' is derived from the pill rather than
// set, so the helper starting outside the dialog lands on it too.
type Step = 'install' | 'asking' | 'blocked' | 'missing'

function downloadUrl(os: Os): string {
  return `https://github.com/giulianoo0/ss-bridge/releases/latest/download/${ASSET[os]}`
}

/**
 * Header pill for the local helper.
 *
 * It polls, so opening the app flips it to green on its own — with a short
 * chime on the rising edge — without the user clicking anything. What it will
 * not do is poll while the browser is still waiting to be asked about local
 * network access: a 600ms probe fired every three seconds would raise the
 * permission bubble behind the user's back and then abort the request holding
 * it up. In that state the polling waits, and the dialog's "I already
 * installed it" button is what asks — from a click, with the prompt explained
 * and pointed at before it appears.
 */
export function BridgeStatus({ t }: { t: Translator }) {
  const [on, setOn] = useState(false)
  const [open, setOpen] = useState(false)
  // 'pending' until the browser has answered; 'unknown' is every browser
  // that does not gate loopback, and polls freely. Starting at 'unknown'
  // instead would fire one probe before the answer arrives — and in a gated
  // browser that one probe is the bubble this whole dialog exists to avoid.
  const [permission, setPermission] = useState<PermissionState | 'unknown' | 'pending'>('pending')
  const [step, setStep] = useState<Step>('install')
  const wasOn = useRef(false)

  const os = detectOs()
  const browser = detectBrowser()
  const anchor = promptAnchor()
  const view: Step | 'connected' = on ? 'connected' : step
  const { shown, morphing } = useMorphingStep(view)

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
    void localNetworkPermission().then((state) => { if (live) setPermission(state) })
    let unwatch: () => void = () => {}
    void watchLocalNetworkPermission((state) => { if (live) setPermission(state) })
      .then((off) => { if (live) unwatch = off; else off() })
    return () => { live = false; unwatch() }
  }, [])

  // Granted or ungated: poll, which is also how the pill notices the app
  // being opened later, on its own. Waiting to be asked, or refused: stay
  // quiet, the requests would only be blocked (or steal the prompt) anyway.
  const mayPoll = permission === 'granted' || permission === 'unknown'

  useEffect(() => {
    if (!mayPoll) { setOn(false); wasOn.current = false; return }
    let live = true
    const tick = () => { if (live) void probe() }
    tick()
    const timer = window.setInterval(tick, 3_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [mayPoll, probe])

  /**
   * The click the whole flow hangs off: it morphs the dialog to the pointing
   * step first, so the arrow is already on screen when the browser draws its
   * bubble over it, and only then fires the request that raises it.
   */
  const askForAccess = async () => {
    setStep('asking')
    const found = await requestHelperAccess()
    // Whatever the answer was, it is an answer: reading it back is what turns
    // the polling on once the permission is granted. From then on the pill
    // notices the app being opened — or closed — on its own, which is the
    // whole point of asking from a click and never before.
    const state = await localNetworkPermission()
    setPermission(state)
    if (found) {
      setOn(true)
      if (!wasOn.current) { try { playConnect() } catch { /* audio blocked */ } }
      wasOn.current = true
      return
    }
    // Nothing answered. Either the permission was refused, or it was granted
    // and the app simply is not running — two different things to say.
    setStep(state === 'denied' ? 'blocked' : 'missing')
  }

  const blockedHint = browser === 'chromium' || browser === 'firefox'
    ? t(`bridge.blocked.${browser}`)
    : t('bridge.blocked.other')

  return (
    <>
      <button
        type="button"
        className={`bridge-status ${on ? 'is-on' : ''}`}
        onClick={() => { setOpen(true); setStep('install'); if (mayPoll) void probe() }}
      >
        <span className="bridge-dot" aria-hidden="true" />
        <span className="nav-label">{on ? t('bridge.on') : t('bridge.off')}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent
            title={t('bridge.title')}
            description={t('bridge.body')}
            closeLabel={t('home.closeDialog')}
          >
            <MorphPanel sizeKey={shown} morphing={morphing} className="bridge-morph">
              {shown === 'connected' ? (
                <p className="bridge-connected">{t('bridge.connected')}</p>
              ) : null}

              {shown === 'install' ? (
                <>
                  <ol className="bridge-steps">
                    <li>{t('bridge.step1')}</li>
                    <li>{t('bridge.step2')}</li>
                    <li>{t('bridge.step3')}</li>
                  </ol>
                  <a className="primary-button bridge-download" href={downloadUrl(os)}>
                    {t('bridge.download')} · {OS_LABEL[os]}
                  </a>
                  <button type="button" className="bridge-already" onClick={() => { void askForAccess() }}>
                    {t('bridge.already')}
                  </button>
                  <div className="bridge-other-os">
                    <span>{t('bridge.otherOs')}</span>
                    {(['mac', 'windows', 'linux'] as Os[]).filter((other) => other !== os).map((other) => (
                      <a key={other} href={downloadUrl(other)}>{OS_LABEL[other]}</a>
                    ))}
                  </div>
                  <p className="bridge-loopback">{t('bridge.loopback')}</p>
                </>
              ) : null}

              {shown === 'asking' ? (
                <div className="bridge-asking">
                  {/* The waiting is the heading itself: a highlight sweeps
                      across the words instead of a spinner sitting beside them. */}
                  <h3 className="bridge-shimmer">{t('bridge.asking.title')}</h3>
                  <p>{t(`bridge.asking.${anchor}`)}</p>
                </div>
              ) : null}

              {shown === 'blocked' ? (
                <div className="bridge-outcome">
                  <h3>{t('bridge.blocked.title')}</h3>
                  <p>{blockedHint}</p>
                  {os === 'mac' ? <p className="bridge-os-note">{t('bridge.macNote')}</p> : null}
                  <button type="button" className="primary-button" onClick={() => { void askForAccess() }}>
                    {t('bridge.retry')}
                  </button>
                </div>
              ) : null}

              {shown === 'missing' ? (
                <div className="bridge-outcome">
                  <h3>{t('bridge.missing.title')}</h3>
                  <p>{t('bridge.missing.body')}</p>
                  {os === 'mac' ? <p className="bridge-os-note">{t('bridge.macNote')}</p> : null}
                  <button type="button" className="primary-button" onClick={() => { void askForAccess() }}>
                    {t('bridge.retry')}
                  </button>
                  <button type="button" className="bridge-already" onClick={() => setStep('install')}>
                    {t('bridge.backToInstall')}
                  </button>
                </div>
              ) : null}
            </MorphPanel>
          </DialogContent>
        ) : null}
      </Dialog>

      {/*
        The pointer at the prompt. It goes straight to the body, above the
        dialog, because the dialog is transformed — a fixed child of it would
        be positioned against the dialog rather than the viewport — and because
        what it points at is outside the page entirely: the bubble Chromium and
        Firefox anchor under the left edge of the address bar, just above the
        viewport's top-left corner on macOS, Windows and Linux alike. Anywhere
        the prompt is a dialog or a system alert there is nothing to point at,
        so the step explains it in words and no arrow is drawn.
      */}
      {open && view === 'asking' && anchor === 'address-bar' && typeof document !== 'undefined'
        ? createPortal(
          <div className="bridge-pointer" role="presentation">
            <svg viewBox="0 0 96 76" aria-hidden="true">
              {/* The curve leaves the tip straight up, so the head is a V
                  symmetric about vertical — anything else reads as a corner. */}
              <path d="M10 8 C 10 42, 34 62, 90 68" fill="none" strokeLinecap="round" />
              <path d="M2 25 L 10 8 L 19 24" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{t('bridge.pointer')}</span>
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
