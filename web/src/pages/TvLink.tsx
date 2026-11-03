import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { discordLoginUrl, useMe } from '../account'
import { LostPage } from '../components/LostPage'
import { SiteHeader } from '../components/SiteHeader'
import { useT } from '../i18n/useT'
import { linkTv } from '../tvlink/api'
import { linkCodeFrom } from '../tvlink/code'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { PillLink } from '../ui/Pill'
import styles from './TvLink.module.css'

type Outcome = 'linking' | 'linked' | 'not_found' | 'failed'

/**
 * Where the TV's QR leads (/tv/vincular?c=CODE), from any phone camera:
 * signs in first when needed, coming back here, then links the code once.
 */
export function TvLinkPage() {
  const t = useT()
  const { me, loading } = useMe()
  const location = useLocation()
  const [params] = useSearchParams()
  const code = linkCodeFrom(params.get('c') ?? '')
  const [outcome, setOutcome] = useState<Outcome>(code ? 'linking' : 'not_found')
  const sent = useRef<string | null>(null)

  useEffect(() => {
    if (!me || !code || sent.current === code) return
    sent.current = code
    linkTv(code).then(
      () => setOutcome('linked'),
      (failure: Error) => setOutcome(failure.message === 'code_not_found' ? 'not_found' : 'failed'),
    )
  }, [me, code])

  const home = <PillLink tone="soft" size="lg" href="/">{t('tv.goHome')}</PillLink>
  let body = null
  if (loading) {
    body = null
  } else if (!me) {
    body = (
      <LostPage
        seed="tv"
        expression="idle"
        title={t('tv.link')}
        action={<PillLink tone="brand" size="lg" icon={<DiscordGlyph size={18} />} href={discordLoginUrl(location.pathname + location.search)}>{t('landing.signIn')}</PillLink>}
      />
    )
  } else if (outcome === 'linking') {
    body = <LostPage seed="tv" title={t('tv.linking')} action={null} />
  } else if (outcome === 'linked') {
    body = <LostPage seed="tv" expression="happy" title={t('tv.linked')} action={home} />
  } else {
    body = <LostPage seed="tv" title={t(outcome === 'not_found' ? 'tv.codeNotFound' : 'tv.linkFailed')} action={home} />
  }

  return (
    <div className={styles.page}>
      <SiteHeader you={Boolean(me)} />
      {body}
    </div>
  )
}
