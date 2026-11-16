import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { refreshMe } from '../account'
import { useT } from '../i18n/useT'
import { isDesktop } from '../platform'
import { pairingCode, randomBytes, toBase64Url } from '../social/crypto'
import { Modal } from '../ui/Modal'
import { Pill } from '../ui/Pill'
import { Spinner } from '../ui/Spinner'
import styles from './DesktopSignIn.module.css'

const POLL_MS = 1500
const GIVE_UP_MS = 10 * 60_000

/**
 * Where the browser of the system opens the sign-in: a host the app's window
 * does not keep, which sends straight to the site. The app hands any other
 * host to the browser, so this works with every app already installed.
 */
export function browserSignInUrl(challenge: string, host = window.location.host): string | null {
  if (host !== 'juntos.lol') return null
  return `https://www.juntos.lol/api/auth/app?poll=1&challenge=${encodeURIComponent(challenge)}`
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return toBase64Url(new Uint8Array(digest))
}

type Attempt = { verifier: string; url: string; code: string; next: string }

/**
 * In the desktop app, Discord's sign-in opens in the person's browser, where
 * Discord already knows them. The app shows the code the browser asks to
 * confirm and waits for the yes; the session then lands in the app.
 */
export function DesktopSignIn() {
  const t = useT()
  const navigate = useNavigate()
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const started = useRef(0)

  useEffect(() => {
    if (!isDesktop()) return
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link) return
      const url = new URL(link.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname !== '/api/auth/discord') return
      void (async () => {
        const verifier = toBase64Url(randomBytes(32))
        const challenge = await challengeOf(verifier)
        const external = browserSignInUrl(challenge)
        if (!external) {
          window.location.href = url.href
          return
        }
        setAttempt({ verifier, url: external, code: await pairingCode(challenge), next: url.searchParams.get('next') ?? '/' })
        started.current = Date.now()
        window.location.href = external
      })()
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  useEffect(() => {
    if (!attempt) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!live) return
      if (Date.now() - started.current > GIVE_UP_MS) { setAttempt(null); return }
      try {
        const response = await fetch('/api/auth/app/poll', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verifier: attempt.verifier }),
        })
        if (response.status === 204) {
          await refreshMe()
          if (!live) return
          setAttempt(null)
          if (attempt.next.startsWith('/') && !attempt.next.startsWith('//')) navigate(attempt.next)
          return
        }
      } catch { /* offline for a moment */ }
      timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    timer = setTimeout(() => { void poll() }, POLL_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [attempt, navigate])

  return (
    <Modal open={attempt !== null} onOpenChange={(open) => { if (!open) setAttempt(null) }} title={t('signin.title')} closeLabel={t('signin.cancel')}>
      <div className={styles.body}>
        <div className={styles.code} aria-label={attempt?.code.split('').join(' ')}>
          {attempt?.code.split('').map((letter, index) => <span key={index} style={{ animationDelay: `${index * 40}ms` }}>{letter}</span>)}
        </div>
        <Spinner size="1.5rem" />
        <div className={styles.actions}>
          <Pill tone="soft" size="md" onClick={() => { if (attempt) window.location.href = attempt.url }}>{t('signin.reopen')}</Pill>
          <Pill tone="soft" size="md" onClick={() => setAttempt(null)}>{t('signin.cancel')}</Pill>
        </div>
      </div>
    </Modal>
  )
}
