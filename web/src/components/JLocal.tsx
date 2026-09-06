import { Check, Download } from 'lucide-react'
import { useT } from '../i18n/useT'
import { JLOCAL_ORIGIN, useJLocal } from '../jlocal/status'
import { Dialog, DialogContent } from '../ui/Dialog'

const RELEASES_URL = 'https://github.com/giulianoo0/jlocal/releases/latest'

function detectOS(): 'win' | 'mac' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux'
  const agent = navigator.userAgent
  if (/windows/i.test(agent)) return 'win'
  if (/mac os|macintosh/i.test(agent)) return 'mac'
  return 'linux'
}

/** Left side of the header's right container: connected or not, opens the modal. Silent. */
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
  return (
    <Dialog open={modalOpen} onOpenChange={setModal}>
      <DialogContent
        className="jlocal-dialog"
        title={t('jlocal.title')}
        description={t('jlocal.guide')}
        closeLabel={t('jlocal.close')}
      >
        <p className="jlocal-state" role="status">
          <span className={`jlocal-dot ${connected ? 'is-on' : ''}`} aria-hidden="true" />
          {connected
            ? <span>{t('jlocal.up')}{version ? ` · ${version}` : ''}</span>
            : <span>{t('jlocal.down')}</span>}
        </p>
        <p className="jlocal-step">{t('jlocal.stepGet')}</p>
        <ul className="jlocal-os-list">
          {OS_ROWS.map((row) => (
            <li key={row.id} className={`jlocal-os ${os === row.id ? 'is-current' : ''}`}>
              <span className="jlocal-os-name">{t(`jlocal.${row.id}`)}</span>
              <span className="jlocal-os-file">{t(row.file)}</span>
              <a className="jlocal-os-link" href={RELEASES_URL} target="_blank" rel="noreferrer">{t('jlocal.get')}</a>
            </li>
          ))}
        </ul>
        <p className="jlocal-step">{t('jlocal.stepOpen')}</p>
        <p className="jlocal-step">{t('jlocal.stepConnect')}</p>
        <div className="jlocal-actions">
          {connected ? (
            <span className="jlocal-connected">
              <Check size={15} aria-hidden="true" />{t('jlocal.connected')}{version ? ` · ${version}` : ''}
            </span>
          ) : (
            <button type="button" className="primary-button" disabled={connecting} onClick={() => connect()}>
              {connecting ? t('jlocal.connecting') : t('jlocal.connect')}
            </button>
          )}
          <button type="button" className="jlocal-probe" onClick={() => connect()}>
            {t('jlocal.retry')}
          </button>
        </div>
        <p className="jlocal-origin">{JLOCAL_ORIGIN}</p>
      </DialogContent>
    </Dialog>
  )
}
