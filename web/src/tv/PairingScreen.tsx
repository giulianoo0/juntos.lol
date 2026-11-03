import { useEffect, useState } from 'react'
import { toString as qrSvg } from 'qrcode'
import { useT } from '../i18n/useT'
import { HeroWordmark } from '../pages/home/Wordmark'
import { formatCode, linkUrl, pairStatus, startPairing, type Pairing, type TvAccount, type TvDevice } from './api'
import styles from './tv.module.css'

const POLL_MS = 2_000
/** After a failed ask for a code (no network, the server restarting). */
const RETRY_MS = 5_000

/**
 * A code and its QR, until a phone links them to an account. A code that
 * runs out, or that the server no longer knows, is swapped for a new one.
 */
export function PairingScreen({ onLinked }: { onLinked: (link: { token: string; account: TvAccount; device: TvDevice }) => void }) {
  const t = useT()
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [qr, setQr] = useState('')
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    let timer: number | null = null
    const later = (run: () => void, ms: number) => { timer = window.setTimeout(run, ms) }
    const renew = () => { if (live) setRound((n) => n + 1) }

    const poll = (current: Pairing) => {
      if (!live) return
      if (Date.parse(current.expiresAt) <= Date.now()) { renew(); return }
      pairStatus(current.pairId).then((status) => {
        if (!live) return
        if (status.status === 'linked') onLinked({ token: status.token, account: status.account, device: status.device })
        else if (status.status === 'expired') renew()
        else later(() => poll(current), POLL_MS)
      }).catch(() => { if (live) later(() => poll(current), POLL_MS) })
    }

    startPairing().then(async (next) => {
      if (!live) return
      const svg = await qrSvg(linkUrl(next.code), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      if (!live) return
      setPairing(next)
      setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      later(() => poll(next), POLL_MS)
    }).catch(() => { if (live) later(renew, RETRY_MS) })

    return () => {
      live = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [round, onLinked])

  return (
    <main className={styles.pairing}>
      <HeroWordmark className={styles.pairingMark} sweep={false} />
      <h1 className={styles.pairingTitle}>{t('tv.pairTitle')}</h1>
      <div className={styles.pairingBody} data-ready={pairing ? '' : undefined}>
        <div className={styles.qr}>
          {pairing && qr ? <img src={qr} alt={linkUrl(pairing.code)} /> : null}
        </div>
        <div className={styles.pairingCode}>
          <span className={styles.pairingUrl}>{window.location.host}/tv/vincular</span>
          <strong className={styles.code}>{pairing ? formatCode(pairing.code) : '····-····'}</strong>
        </div>
      </div>
    </main>
  )
}
