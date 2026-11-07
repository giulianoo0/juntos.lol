import { Dialog } from '@base-ui/react/dialog'
import { ChevronLeft, Plus, Puzzle, Upload, X } from 'lucide-react'
import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { useT } from '../i18n/useT'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import type { LoadedExtension } from './bridge'
import { ExtensionFrame } from './ExtensionFrame'
import { installedExtension, listInstalled, saveInstalled, updateFor, type InstalledExtension } from './installed'
import type { ExtPlay, ExtToHost, ExtensionManifest, ExtensionPlace } from './protocol'
import { ExtensionError, latestExtension, parseRepo, registerExtension } from './registry'
import styles from './ExtensionsPanel.module.css'

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'publish' }
  | { kind: 'confirm'; extension: LoadedExtension; update: boolean }
  | { kind: 'open'; extension: LoadedExtension }

interface ExtensionsPanelProps {
  open: boolean
  canPlay: boolean
  /** The account may register new extension ids. */
  canPublish?: boolean
  place?: ExtensionPlace
  onClose: () => void
  onPlay: (extension: LoadedExtension, play: ExtPlay) => void
  onToast: (text: string) => void
}

function errorKey(error: unknown): string {
  return `extensions.error.${error instanceof ExtensionError ? error.code : 'failed'}`
}

function reachedHosts(manifest: ExtensionManifest): string[] {
  const { connect, images, media } = manifest.hosts
  return [...new Set([...connect, ...images, ...media])]
}


/**
 * Where this device's extensions are listed, installed by id and opened, and
 * where the accounts that may publish register a repository. Nothing comes
 * installed, and nothing reaches a new host before this device saw the hosts
 * and said yes. Each extension runs in its own origin inside the panel.
 */
export function ExtensionsPanel({ open, canPlay, canPublish = false, place, onClose, onPlay, onToast }: ExtensionsPanelProps) {
  const t = useT()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [installed, setInstalled] = useState<InstalledExtension[]>(listInstalled)
  const [id, setId] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const confirm = (extension: LoadedExtension) => {
    setView({ kind: 'confirm', extension, update: installedExtension(extension.id) !== null })
  }

  const openInstalled = (entry: InstalledExtension) => attempt(async () => {
    const current = installedExtension(entry.id) ?? entry
    const next = await latestExtension(entry.id, place?.raw)
    const update = updateFor(current, next)
    if (update.kind === 'current') {
      setView({ kind: 'open', extension: current })
    } else if (update.kind === 'approve') {
      confirm(next)
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
  const title = view.kind === 'open' || view.kind === 'confirm' ? view.extension.manifest.name : t('extensions.title')
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

          {view.kind === 'confirm' ? (
            <div className={styles.body}>
              <h3 id="extension-hosts" className={styles.section}>{t('extensions.reaches')}</h3>
              <ul className={styles.hosts} aria-labelledby="extension-hosts">
                {reachedHosts(view.extension.manifest).map((host) => <li key={host}>{host}</li>)}
              </ul>
              <div className={styles.actions}>
                <Button variant="primary" onClick={() => approve(view.extension)}>
                  {t(view.update ? 'extensions.update' : 'extensions.install')}
                </Button>
              </div>
            </div>
          ) : null}

          {opened ? (
            <ExtensionFrame className={styles.frame} extension={opened} place={place} canPlay={canPlay} onMessage={onMessage} />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
