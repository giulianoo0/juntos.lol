import type { Translator } from '../i18n/useT'
import type { WorkerProbe } from '../torrent'

// The fleet, as measured from this browser, wherever a torrent is being
// opened: one pill per worker, the chosen one lit. The measurement is the
// user's own connection speaking — it deserves to be seen.

// A worker the browser could not reach at an address that looks like a
// private network is usually the browser refusing, not the worker missing:
// Chrome gates public sites off local addresses behind a permission.
function looksLocal(readBase: string): boolean {
  try {
    const host = new URL(readBase).hostname
    return host.endsWith('.ts.net') || host.endsWith('.local') || /^(10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  } catch {
    return false
  }
}

export function WorkerProbes({ probes, t }: { probes: WorkerProbe[]; t: Translator }) {
  if (probes.length === 0) return null
  return (
    <div className="worker-probes" aria-live="polite">
      <span className="worker-probes-title">
        {probes.some((p) => p.state === 'testing') ? t('home.workersTesting') : t('home.workersTested')}
      </span>
      {probes.map((probe) => (
        <span key={probe.id} className={`worker-probe ${probe.chosen ? 'is-chosen' : ''} ${probe.state === 'down' ? 'is-down' : ''}`}>
          <code>{probe.id.replace(/^w_/, '').slice(0, 6)}</code>
          {probe.state === 'testing' ? t('home.workerTesting')
            : probe.state === 'down' ? (looksLocal(probe.readBase) ? t('home.workerLocalBlocked') : t('home.workerOffline'))
              : `${probe.mbit} Mbit/s${probe.ttfbMs !== undefined ? ` · ${probe.ttfbMs}ms` : ''}`}
          {probe.holds ? <em>{t('home.workerHolds')}</em> : null}
          {probe.chosen ? <strong>{t('home.workerChosen')}</strong> : null}
        </span>
      ))}
    </div>
  )
}
