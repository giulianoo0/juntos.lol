import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Puzzle, Trash2, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'
import { buildInstall, canonicalRepoUrl, fetchGitPlugin, readManifestFromSource } from './install'
import { deletePlugin, getPlugin, listPlugins, originId, putPlugin, type InstalledPlugin, type PluginOrigin } from './store'
import { approvePendingUpdate, updateAll, updateUrlOf } from './update'
import type { PluginManifest } from './manifest'

type Step = 'list' | 'add'

/** A plugin read but not yet stored — what the confirmation screen shows. */
interface Candidate {
  source: string
  manifest: PluginManifest
  origin: PluginOrigin
  replaces: InstalledPlugin | null
}

export function PluginsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null)
  const [step, setStep] = useState<Step>('list')
  const [repoUrl, setRepoUrl] = useState('')
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const view: Step | 'confirm' = candidate ? 'confirm' : step
  const { shown, morphing } = useMorphingStep(view)

  const refresh = useCallback(async () => setInstalled(await listPlugins()), [])

  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const read = async (source: string, origin: PluginOrigin) => {
    setBusy(true)
    setError(null)
    try {
      const manifest = await readManifestFromSource(source)
      const resolved: PluginOrigin = origin.kind === 'file'
        ? { ...origin, updateUrl: origin.updateUrl ?? (manifest.updateUrl ? canonicalRepoUrl(manifest.updateUrl) : null) }
        : origin
      setCandidate({ source, manifest, origin, replaces: await getPlugin(await originId(resolved)) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const fromRepo = async () => {
    setBusy(true)
    setError(null)
    try {
      const address = canonicalRepoUrl(repoUrl.trim())
      const { source, commit } = await fetchGitPlugin(address)
      await read(source, { kind: 'git', updateUrl: address, commit })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const fromFile = async (file: File) => {
    await read(await file.text(), { kind: 'file', fileName: file.name, updateUrl: null })
  }

  const confirm = async () => {
    if (!candidate) return
    await putPlugin(await buildInstall(candidate.source, candidate.origin, {
      readManifest: () => Promise.resolve(candidate.manifest),
    }))
    setCandidate(null)
    setRepoUrl('')
    setStep('list')
    await refresh()
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const file = event.dataTransfer.files[0]
    if (file) void fromFile(file)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="plugins-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('plugins.title')}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <MorphPanel sizeKey={shown} morphing={morphing} className="plugins-morph">
        <div className="plugins-panel" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="plugins-close" aria-label={t('plugins.close')} onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>

          <AnimatePresence mode="wait" initial={false}>
            {shown === 'confirm' && candidate ? (
              <motion.div key="confirm" className="plugins-step">
                <StepBack label={t('plugins.back')} onClick={() => setCandidate(null)} />
                <h2>{candidate.manifest.name}</h2>
                <p className="plugins-version">{candidate.manifest.version}</p>
                <p className="plugins-note">{t('plugins.willReach')}</p>
                <ul className="plugins-hosts">
                  {candidate.manifest.hosts.map((host) => <li key={host}>{host}</li>)}
                </ul>
                {candidate.manifest.updateUrl ? (
                  <p className="plugins-note">{t('plugins.updatesFrom')} {candidate.manifest.updateUrl}</p>
                ) : null}
                {candidate.replaces ? (
                  <p className="plugins-note plugins-replaces">
                    {t('plugins.replaces')} {candidate.replaces.manifest.name} {candidate.replaces.manifest.version}
                  </p>
                ) : null}
                <button type="button" className="primary-button raised" onClick={() => void confirm()}>
                  {candidate.replaces ? t('plugins.replace') : t('plugins.install')}
                </button>
              </motion.div>
            ) : shown === 'add' ? (
              <motion.div key="add" className="plugins-step">
                <StepBack label={t('plugins.back')} onClick={() => setStep('list')} />
                <button
                  type="button"
                  className="plugins-drop"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
                  onDrop={onDrop}
                >
                  {t('plugins.dropHint')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".js,text/javascript"
                  aria-label={t('plugins.dropHint')}
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void fromFile(file)
                  }}
                />
                <label className="plugins-url">
                  <span>{t('plugins.repoLabel')}</span>
                  <input
                    type="url"
                    value={repoUrl}
                    placeholder="https://github.com/user/repo"
                    onChange={(event) => setRepoUrl(event.target.value)}
                  />
                </label>
                <button type="button" className="primary-button" disabled={busy || repoUrl.trim() === ''} onClick={() => void fromRepo()}>
                  {t('plugins.fetch')}
                </button>
                {error ? <p className="empty-copy">{error}</p> : null}
              </motion.div>
            ) : (
              <motion.div key="list" className="plugins-step">
                <h2>{t('plugins.title')}</h2>
                {installed === null ? null : installed.length === 0 ? (
                  <p className="empty-copy">{t('plugins.empty')}</p>
                ) : (
                  <ul className="plugins-list">
                    {installed.map((plugin) => (
                      <li key={plugin.id}>
                        <span className="plugins-name">{plugin.manifest.name}</span>
                        <span className="plugins-meta">
                          {plugin.manifest.version} · {plugin.origin.kind === 'git' ? plugin.origin.updateUrl : plugin.origin.fileName}
                        </span>
                        <code className="plugins-hash">{plugin.sha256.slice(0, 12)}</code>
                        <input
                          type="checkbox"
                          checked={plugin.enabled}
                          aria-label={`${t('plugins.enable')} ${plugin.manifest.name}`}
                          onChange={async () => {
                            await putPlugin({ ...plugin, enabled: !plugin.enabled })
                            await refresh()
                          }}
                        />
                        <button
                          type="button"
                          aria-label={`${t('plugins.remove')} ${plugin.manifest.name}`}
                          onClick={async () => { await deletePlugin(plugin.id); await refresh() }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                        {plugin.pendingUpdate ? (
                          <div className="plugins-held">
                            <p>{t('plugins.heldUpdate')} {plugin.pendingUpdate.newHosts.join(', ')}</p>
                            <button
                              type="button"
                              onClick={async () => { await approvePendingUpdate(plugin); await refresh() }}
                            >
                              {t('plugins.approve')}
                            </button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="plugins-actions">
                  <button type="button" className="primary-button raised" onClick={() => setStep('add')}>
                    <Puzzle size={15} aria-hidden="true" />{t('plugins.add')}
                  </button>
                  {installed && installed.some((plugin) => updateUrlOf(plugin) !== null) ? (
                    <button type="button" onClick={async () => { await updateAll(); await refresh() }}>
                      {t('plugins.updateAll')}
                    </button>
                  ) : null}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </MorphPanel>
    </div>
  )
}
