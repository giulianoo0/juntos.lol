/**
 * The desktop app's own update, as the site shows it. The app downloads a
 * new version in the background; once it is ready a small notice offers the
 * restart, and nothing restarts unless asked (it also goes in when the app
 * closes). An app too old for this site gets a screen of its own instead:
 * the update is fetched at once and applied as soon as it lands.
 */
import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { appUpdateRequired, invokeUpdater } from '../platform'
import { Pill } from '../ui/Pill'
import styles from './AppUpdate.module.css'

type UpdateStatus =
  | { state: 'idle' | 'checking' }
  | { state: 'downloading'; version: string; received: number; total: number | null }
  | { state: 'ready'; version: string }
  | { state: 'failed'; error: string }

const POLL_MS = 30_000
const POLL_BUSY_MS = 1_000

export function AppUpdate() {
  const t = useT()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [required, setRequired] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      let next: UpdateStatus | null = null
      try {
        next = await invokeUpdater<UpdateStatus>('update_status')
      } catch {}
      if (!live || next === null) return
      setStatus(next)
      const busy = next.state === 'checking' || next.state === 'downloading'
      timer = setTimeout(() => { void poll() }, busy ? POLL_BUSY_MS : POLL_MS)
    }
    void (async () => {
      const mustUpdate = await appUpdateRequired()
      if (!live) return
      setRequired(mustUpdate)
      if (mustUpdate) void invokeUpdater('update_now').catch(() => undefined)
      void poll()
    })()
    return () => {
      live = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const restart = () => {
    setRestarting(true)
    void invokeUpdater('update_restart').catch(() => setRestarting(false))
  }

  // Nothing of the site works on an app this old: the new version goes in as soon as it lands.
  const autoRestarted = useRef(false)
  useEffect(() => {
    if (!required || status?.state !== 'ready' || autoRestarted.current) return
    autoRestarted.current = true
    void invokeUpdater('update_restart').catch(() => { autoRestarted.current = false })
  }, [required, status])

  if (required) {
    const pct = status?.state === 'downloading' && status.total ? Math.round((status.received / status.total) * 100) : null
    return (
      <div className={styles.screen} role="dialog" aria-modal="true" aria-labelledby="app-update-title">
        <h1 id="app-update-title" className={styles.title}>{t('app.updateRequired')}</h1>
        <div
          className={styles.track}
          role="progressbar"
          aria-label={t('app.updating')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <span className={styles.fill} data-indeterminate={pct === null || undefined} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  if (status?.state !== 'ready') return null
  return (
    <div className={styles.notice} role="status">
      <span className={styles.label}>{t('app.updateReady')}</span>
      <Pill tone="primary" size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={restarting} onClick={restart}>
        {t('app.restart')}
      </Pill>
    </div>
  )
}
