import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useT } from '../i18n/useT'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Pill } from '../ui/Pill'
import { linkTv } from './api'
import { codeFromQr, formatCodeInput, linkCodeFrom } from './code'
import { canScan, scanQr } from './qr'
import styles from './LinkTvDialog.module.css'

/**
 * "Vincular TV": the camera reading the TV's QR, and the field for its
 * code. A read QR links at once; so does the code, on Vincular.
 */
export function LinkTvDialog({ open, onOpenChange, onLinked, link = linkTv }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked?: () => void
  /** The call that links; the API's by default, a fake one on /dev/sala. */
  link?: (code: string) => Promise<unknown>
}) {
  const t = useT()
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('tv.link')} closeLabel={t('tv.close')}>
      {/* Mounted with the popup: each opening starts clean, camera and all. */}
      <LinkTvBody link={link} done={() => { onOpenChange(false); onLinked?.() }} />
    </Modal>
  )
}

function LinkTvBody({ link, done }: { link: (code: string) => Promise<unknown>; done: () => void }) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [camera, setCamera] = useState<'asking' | 'on' | 'off'>(() => (canScan() ? 'asking' : 'off'))
  const videoRef = useRef<HTMLVideoElement>(null)
  const tried = useRef<string | null>(null)

  const submit = async (code: string) => {
    setBusy(true)
    setError('')
    try {
      await link(code)
      toast(t('tv.linked'))
      done()
    } catch (failure) {
      setError(t((failure as Error).message === 'code_not_found' ? 'tv.codeNotFound' : 'tv.linkFailed'))
    } finally {
      setBusy(false)
    }
  }
  const submitRef = useRef(submit)
  useEffect(() => { submitRef.current = submit })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    const abort = new AbortController()
    scanQr(video, abort.signal, (text) => {
      const code = codeFromQr(text)
      // A code that failed is not tried again until another one shows.
      if (!code || code === tried.current) return false
      tried.current = code
      setTyped(formatCodeInput(code))
      void submitRef.current(code)
      return false
    }, () => setCamera('on')).catch(() => setCamera('off'))
    return () => abort.abort()
  }, [])

  const code = linkCodeFrom(typed)
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (code) void submit(code)
  }

  return (
    <div className={styles.body}>
      {camera === 'off' ? null : (
        <div className={styles.viewfinder} data-on={camera === 'on' || undefined}>
          <video ref={videoRef} className={styles.video} aria-label={t('tv.camera')} muted playsInline autoPlay />
          <span className={styles.frame} aria-hidden="true" />
        </div>
      )}
      <form className={styles.form} onSubmit={onSubmit}>
        <Field
          mono
          className={styles.code}
          aria-label={t('tv.code')}
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          error={error || undefined}
          onChange={(event) => { setTyped(formatCodeInput(event.target.value)); setError('') }}
        />
        <Pill type="submit" tone="brand" size="lg" block loading={busy} disabled={!code}>{t('tv.linkAction')}</Pill>
      </form>
    </div>
  )
}
