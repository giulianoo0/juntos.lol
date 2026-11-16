import { Copy, Eye } from 'lucide-react'
import { toString as qrSvg } from 'qrcode'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useT } from '../i18n/useT'
import { canScan, scanQr } from '../tvlink/qr'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Pill } from '../ui/Pill'
import { Segmented } from '../ui/Segmented'
import { KeyImportError } from './crypto'
import { exportKey, importKey } from './inbox'
import styles from './KeyDialog.module.css'

type Mode = 'show' | 'use'

/** Carrying the message key between one's own devices: this one's as a QR and text, or another's read in. */
export function KeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('social.key')} closeLabel={t('social.close')}>
      <KeyBody done={() => onOpenChange(false)} />
    </Modal>
  )
}

function KeyBody({ done }: { done: () => void }) {
  const t = useT()
  const [mode, setMode] = useState<Mode>('show')
  return (
    <div className={styles.body}>
      <Segmented
        label={t('social.key')}
        options={[{ value: 'show', label: t('social.keyShow') }, { value: 'use', label: t('social.keyUse') }]}
        value={mode}
        onChange={setMode}
      />
      {mode === 'show' ? <ShowKey /> : <UseKey done={done} />}
    </div>
  )
}

function ShowKey() {
  const t = useT()
  const [key, setKey] = useState<string | null | undefined>(undefined)
  const [svg, setSvg] = useState('')
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    let live = true
    void exportKey().then(async (text) => {
      if (!live) return
      setKey(text)
      if (text) {
        const drawn = await qrSvg(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'L', color: { dark: '#111111', light: '#ffffff' } })
        if (live) setSvg(drawn)
      }
    })
    return () => { live = false }
  }, [])

  if (key === null) return <p className={styles.note}>{t('social.keyLocked')}</p>
  return (
    <>
      <button
        type="button"
        className={styles.qr}
        data-revealed={revealed || undefined}
        aria-label={t('social.keyReveal')}
        onClick={() => setRevealed(true)}
      >
        <span className={styles.qrArt} dangerouslySetInnerHTML={{ __html: svg }} />
        {revealed ? null : <span className={styles.veil}><Eye size={18} />{t('social.keyReveal')}</span>}
      </button>
      <Pill
        tone="soft"
        size="lg"
        block
        icon={<Copy size={16} />}
        disabled={!key}
        onClick={() => {
          if (!key) return
          void navigator.clipboard.writeText(key).then(() => toast(t('social.keyCopied')), () => toast(t('social.keyCopyFailed')))
        }}
      >
        {t('social.keyCopy')}
      </Pill>
    </>
  )
}

function UseKey({ done }: { done: () => void }) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [camera, setCamera] = useState<'asking' | 'on' | 'off'>(() => (canScan() ? 'asking' : 'off'))
  const videoRef = useRef<HTMLVideoElement>(null)
  const tried = useRef<string | null>(null)

  const submit = async (text: string) => {
    setBusy(true)
    setError('')
    try {
      await importKey(text)
      toast(t('social.keyTaken'))
      done()
    } catch (failure) {
      setError(t(failure instanceof KeyImportError && failure.reason === 'other_account' ? 'social.keyOtherAccount' : 'social.keyInvalid'))
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
      if (!text.startsWith('juntos-key:') || text === tried.current) return false
      tried.current = text
      void submitRef.current(text)
      return false
    }, () => setCamera('on')).catch(() => setCamera('off'))
    return () => abort.abort()
  }, [])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (typed.trim()) void submit(typed)
  }

  return (
    <>
      {camera === 'off' ? null : (
        <div className={styles.viewfinder} data-on={camera === 'on' || undefined}>
          <video ref={videoRef} className={styles.video} aria-label={t('tv.camera')} muted playsInline autoPlay />
          <span className={styles.frame} aria-hidden="true" />
        </div>
      )}
      <form className={styles.form} onSubmit={onSubmit}>
        <Field
          mono
          aria-label={t('social.keyPaste')}
          placeholder="juntos-key:…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={typed}
          error={error || undefined}
          onChange={(event) => { setTyped(event.target.value); setError('') }}
        />
        <Pill type="submit" tone="brand" size="lg" block loading={busy} disabled={!typed.trim()}>{t('social.keyUseAction')}</Pill>
      </form>
    </>
  )
}
