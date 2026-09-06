import { Check, Download } from 'lucide-react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN, useJLocal } from '../jlocal/status'
import { Dialog, DialogContent } from '../ui/Dialog'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'

const RELEASES_URL = 'https://github.com/giulianoo0/jlocal/releases/latest'

function detectOS(): 'win' | 'mac' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux'
  const agent = navigator.userAgent
  if (/windows/i.test(agent)) return 'win'
  if (/mac os|macintosh/i.test(agent)) return 'mac'
  return 'linux'
}

/** Header status pill: connected or not, opens the download modal. Silent. */
export function JLocalStatus() {
  const { connected, setModal } = useJLocal()
  const t = useT()
  return (
    <button
      type="button"
      className={`jlocal-status ${connected ? 'is-on' : ''}`}
      onClick={() => setModal(true)}
      aria-label={t(connected ? 'jlocal.up' : 'jlocal.down')}
    >
      <span className="jlocal-dot" aria-hidden="true" />
      <span className="jlocal-label">{t(connected ? 'jlocal.up' : 'jlocal.down')}</span>
    </button>
  )
}

/** Far right of the header: orange pill, opens the onboarding modal. Asks for nothing. */
export function JLocalDownload() {
  const { setModal } = useJLocal()
  const t = useT()
  return (
    <button type="button" className="jlocal-download" onClick={() => setModal(true)} aria-label={t('jlocal.download')}>
      <Download size={15} aria-hidden="true" />
      <span className="nav-label">{t('jlocal.download')}</span>
    </button>
  )
}

const OS_ROWS = [
  { id: 'win', file: 'jlocal.winFile' },
  { id: 'mac', file: 'jlocal.macFile' },
  { id: 'linux', file: 'jlocal.linuxFile' },
] as const

export function JLocalModal() {
  const { connected, connecting, version, modalOpen, setModal, connect } = useJLocal()
  const t = useT()
  const os = detectOS()
  // The connect action swaps idle → connecting → connected; the shown step
  // trails one beat so the outgoing state dissolves before the next lands,
  // and the box travels between the sizes each state needs.
  const step = connected ? 'connected' : connecting ? 'connecting' : 'idle'
  const { shown, morphing } = useMorphingStep(step)
  return (
    <Dialog open={modalOpen} onOpenChange={setModal}>
      <DialogContent
        className="jlocal-dialog"
        title={t('jlocal.title')}
        description={t('jlocal.guide')}
        closeLabel={t('jlocal.close')}
      >
        <MorphPanel sizeKey={shown} morphing={morphing} className="jlocal-morph">
          <p className="jlocal-state" role="status">
            <span className={`jlocal-dot ${shown === 'connected' ? 'is-on' : ''}`} aria-hidden="true" />
            {shown === 'connected'
              ? <span>{t('jlocal.up')}{version ? ` · ${version}` : ''}</span>
              : <span>{t('jlocal.down')}</span>}
          </p>
          <p className="jlocal-step">{t('jlocal.stepGet')}</p>
          <ul className="jlocal-os-list">
            {OS_ROWS.map((row) => (
              <li key={row.id} className={`jlocal-os ${os === row.id ? 'is-current' : ''}`}>
                <span className="jlocal-os-text">
                  <span className="jlocal-os-name">{t(`jlocal.${row.id}`)}</span>
                  <span className="jlocal-os-file">{t(row.file)}</span>
                </span>
                <a className="jlocal-os-link" href={RELEASES_URL} target="_blank" rel="noreferrer">{t('jlocal.get')}</a>
              </li>
            ))}
          </ul>
          <p className="jlocal-step">{t('jlocal.stepOpen')}</p>
          <p className="jlocal-step">{t('jlocal.stepConnect')}</p>
          <div className="torrent-actions">
            {shown === 'connected' ? (
              <span className="jlocal-connected">
                <Check size={15} aria-hidden="true" />{t('jlocal.connected')}{version ? ` · ${version}` : ''}
              </span>
            ) : (
              <>
                <button type="button" className="primary-button" disabled={shown === 'connecting'} onClick={() => connect()}>
                  {shown === 'connecting' ? t('jlocal.connecting') : t('jlocal.connect')}
                </button>
                <button type="button" className="jlocal-probe" onClick={() => connect()}>
                  {t('jlocal.retry')}
                </button>
              </>
            )}
          </div>
        </MorphPanel>
        <p className="jlocal-origin">{JLOCAL_ORIGIN}</p>
      </DialogContent>
    </Dialog>
  )
}
