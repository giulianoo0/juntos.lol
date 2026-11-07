import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { ChevronLeft, Plus, Puzzle, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useT } from '../i18n/useT'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import type { LoadedExtension } from './bridge'
import { ExtensionFrame } from './ExtensionFrame'
import { ensureDefaults, installedExtension, listInstalled, saveInstalled, updateFor, type InstalledExtension } from './installed'
import type { ExtPlay, ExtToHost, ExtensionPlace } from './protocol'
import { ExtensionError, latestExtension, parseRepo, registerExtension } from './registry'
import styles from './ExtensionsPanel.module.css'

const NO_DEFAULTS: readonly string[] = []

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'publish' }
  | { kind: 'open'; extension: LoadedExtension }

interface ExtensionsPanelProps {
  open: boolean
  canPlay: boolean
  /** The account may register new extension ids. */
  canPublish?: boolean
  place?: ExtensionPlace
  /** Ids installed here without asking, and kept current the same way. */
  defaults?: readonly string[]
  onClose: () => void
  onPlay: (extension: LoadedExtension, play: ExtPlay) => void
  onToast: (text: string) => void
}

function errorKey(error: unknown): string {
  return `extensions.error.${error instanceof ExtensionError ? error.code : 'failed'}`
}

/** A version waiting for the person's yes; `current` opens instead when they say no to an update. */
interface Pending {
  extension: LoadedExtension
  update: boolean
  current?: LoadedExtension
}


/**
 * Where this device's extensions are listed, installed by id and opened, and
 * where the accounts that may publish register a repository. Nothing comes
 * installed, and nothing reaches a new host before this device saw the hosts
 * and said yes. Each extension runs in its own origin inside the panel.
 */
export function ExtensionsPanel({ open, canPlay, canPublish = false, place, defaults = NO_DEFAULTS, onClose, onPlay, onToast }: ExtensionsPanelProps) {
  const t = useT()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [installed, setInstalled] = useState<InstalledExtension[]>(listInstalled)
  const [id, setId] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    if (!open || defaults.length === 0) return
    let live = true
    void ensureDefaults(defaults, place?.raw).then(() => { if (live) setInstalled(listInstalled()) })
    return () => { live = false }
  }, [open, defaults, place?.raw])

  const close = useCallback(() => {
    setError(null)
    onClose()
  }, [onClose])

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (failure) {
      setError(t(errorKey(failure)))
    } finally {
      setBusy(false)
    }
  }

  const confirm = (extension: LoadedExtension, current?: LoadedExtension) => {
    setPending({ extension, update: installedExtension(extension.id) !== null, current })
  }

  const openInstalled = (entry: InstalledExtension) => attempt(async () => {
    const current = installedExtension(entry.id) ?? entry
    const next = await latestExtension(entry.id, place?.raw)
    const update = updateFor(current, next)
    if (update.kind === 'current') {
      setView({ kind: 'open', extension: current })
    } else if (update.kind === 'approve' && !defaults.includes(entry.id)) {
      confirm(next, current)
    } else {
      saveInstalled(next)
      setInstalled(listInstalled())
      setView({ kind: 'open', extension: next })
    }
  })

  const fetchID = (event: FormEvent) => {
    event.preventDefault()
    void attempt(async () => confirm(await latestExtension(id, place?.raw)))
  }

  const publish = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseRepo(repo)
    if (!parsed) { setError(t('extensions.error.bad_repo')); return }
    void attempt(async () => confirm(await registerExtension(parsed)))
  }

  const approve = (extension: LoadedExtension) => {
    setPending(null)
    saveInstalled(extension)
    setInstalled(listInstalled())
    setId('')
    setRepo('')
    setView({ kind: 'open', extension })
  }

  const onMessage = useCallback((message: ExtToHost) => {
    if (view.kind !== 'open') return
    if (message.type === 'play' && canPlay) onPlay(view.extension, message)
    else if (message.type === 'close') close()
    else if (message.type === 'toast') onToast(message.text)
  }, [view, canPlay, onPlay, close, onToast])

  const go = (next: View) => { setError(null); setView(next) }
  const decline = () => {
    const current = pending?.current
    setPending(null)
    if (current) setView({ kind: 'open', extension: current })
  }

  const title = view.kind === 'open' ? view.extension.manifest.name : t('extensions.title')
  const opened = useMemo(() => view.kind === 'open' ? view.extension : null, [view])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={styles.popup} data-view={view.kind}>
          <header className={styles.head}>
            {view.kind !== 'list' ? (
              <button type="button" className={styles.round} aria-label={t('extensions.back')} title={t('extensions.back')} onClick={() => go({ kind: 'list' })}>
                <ChevronLeft size={17} aria-hidden="true" />
              </button>
            ) : null}
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            {view.kind === 'list' ? (
              <>
                {canPublish ? (
                  <Button variant="ghost" size="small" onClick={() => go({ kind: 'publish' })}>
                    <Upload size={15} aria-hidden="true" />{t('extensions.publish')}
                  </Button>
                ) : null}
                <Button variant="ghost" size="small" onClick={() => go({ kind: 'add' })}>
                  <Plus size={15} aria-hidden="true" />{t('extensions.add')}
                </Button>
              </>
            ) : null}
            <Dialog.Close className={styles.round} aria-label={t('extensions.close')} title={t('extensions.close')}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </header>

          {view.kind === 'list' ? (
            <div className={styles.body}>
              {installed.length === 0 ? (
                <p className={styles.empty}>{t('extensions.empty')}</p>
              ) : (
                <ul className={styles.list} aria-label={t('extensions.title')} aria-busy={busy || undefined}>
                  {installed.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" className={styles.row} disabled={busy} onClick={() => { void openInstalled(entry) }}>
                        <Puzzle size={16} aria-hidden="true" />
                        <span className={styles.name}>{entry.manifest.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
            </div>
          ) : null}

          {view.kind === 'add' ? (
            <form className={styles.body} onSubmit={fetchID}>
              <Field label={t('extensions.id')} value={id} onChange={(event) => setId(event.target.value)} autoFocus spellCheck={false} autoCapitalize="off" mono />
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
              <div className={styles.actions}>
                <Button type="submit" variant="primary" loading={busy}>{t('extensions.fetch')}</Button>
              </div>
            </form>
          ) : null}

          {view.kind === 'publish' ? (
            <form className={styles.body} onSubmit={publish}>
              <Field label={t('extensions.repo')} value={repo} onChange={(event) => setRepo(event.target.value)} autoFocus spellCheck={false} autoCapitalize="off" mono />
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
              <div className={styles.actions}>
                <Button type="submit" variant="primary" loading={busy}>{t('extensions.publishSubmit')}</Button>
              </div>
            </form>
          ) : null}

          {opened ? (
            <ExtensionFrame className={styles.frame} extension={opened} place={place} canPlay={canPlay} onMessage={onMessage} />
          ) : null}
          <ConfirmExtension pending={pending} onConfirm={approve} onCancel={decline} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface ConfirmExtensionProps {
  pending: Pending | null
  onConfirm: (extension: LoadedExtension) => void
  onCancel: () => void
}

/**
 * The one question before an extension runs, or before a new version of it
 * does. "Cancelar" comes first, so it takes the initial focus: Enter on an
 * unread dialog never installs.
 */
function ConfirmExtension({ pending, onConfirm, onCancel }: ConfirmExtensionProps) {
  const t = useT()
  // The question stays while the dialog springs back.
  const [shown, setShown] = useState(pending)
  if (pending !== null && pending !== shown) setShown(pending)
  const name = shown?.extension.manifest.name ?? ''
  return (
    <AlertDialog.Root open={pending !== null} onOpenChange={(next) => { if (!next) onCancel() }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={styles.confirmBackdrop} />
        <AlertDialog.Popup className={styles.confirm}>
          <span className={styles.badge} aria-hidden="true">
            <Puzzle size={26} />
          </span>
          <AlertDialog.Title className={styles.confirmTitle}>
            {t(shown?.update ? 'extensions.confirmUpdate' : 'extensions.confirmInstall').replace('{name}', name)}
          </AlertDialog.Title>
          <div className={styles.confirmActions}>
            <AlertDialog.Close className={styles.cancel}>{t('extensions.cancel')}</AlertDialog.Close>
            <button type="button" className={styles.accept} onClick={() => { if (shown) onConfirm(shown.extension) }}>
              {t(shown?.update ? 'extensions.update' : 'extensions.install')}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
