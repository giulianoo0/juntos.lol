import { Cpu, Download, Zap } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import { useT } from '../i18n/useT'
import { isDesktop } from '../platform'
import { GITHUB_URL } from '../ui/GithubGlyph'
import { Modal } from '../ui/Modal'
import { AppleGlyph, LinuxGlyph, WindowsGlyph } from '../ui/PlatformGlyphs'
import { DiaText, Loading, Skeleton } from '../ui/Shimmer'
import { Tip } from '../ui/Tip'
import { YoutubeGlyph } from '../ui/YoutubeGlyph'
import toggle from '../ui/ThemeToggle.module.css'
import { latestDesktopRelease, type DesktopRelease, type Platform } from './desktopRelease'
import styles from './DownloadApp.module.css'

/** Stable asset names of every desktop release: the way down when GitHub's API can't answer. */
const FALLBACK = `${GITHUB_URL}/releases/latest/download`

const PLATFORMS: { id: Platform, name: string, file: string, Glyph: ComponentType<{ size?: number }> }[] = [
  { id: 'mac', name: 'macOS', file: 'Juntos.dmg', Glyph: AppleGlyph },
  { id: 'windows', name: 'Windows', file: 'Juntos-setup.exe', Glyph: WindowsGlyph },
  { id: 'linux', name: 'Linux', file: 'Juntos.AppImage', Glyph: LinuxGlyph },
]

type ReleaseState = { status: 'loading' } | { status: 'ready', release: DesktopRelease | null } | { status: 'failed' }

export function currentPlatform(userAgent = navigator.userAgent): Platform | null {
  if (/iPhone|iPad|Android/i.test(userAgent)) return null
  if (/Mac/i.test(userAgent)) return 'mac'
  if (/Win/i.test(userAgent)) return 'windows'
  if (/Linux|X11/i.test(userAgent)) return 'linux'
  return null
}

function useDesktopRelease(open: boolean): ReleaseState {
  const [state, setState] = useState<ReleaseState>({ status: 'loading' })
  useEffect(() => {
    if (!open || state.status === 'ready') return
    let live = true
    setState({ status: 'loading' })
    latestDesktopRelease().then(
      (release) => { if (live) setState({ status: 'ready', release }) },
      () => { if (live) setState({ status: 'failed' }) },
    )
    return () => { live = false }
  }, [open])
  return state
}

/** The round way to the desktop app, beside the GitHub link; gone on phones, which have no app, and in the app. */
export function DownloadApp() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const release = useDesktopRelease(open)
  const mine = currentPlatform()
  // Inside the app there is nothing to download.
  if (!mine || isDesktop()) return null
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
  const version = release.status === 'ready' ? release.release?.version : undefined
  const hrefFor = (id: Platform, file: string): string | undefined => {
    if (release.status === 'failed') return `${FALLBACK}/${file}`
    if (release.status === 'ready') return release.release?.downloads[id]
    return undefined
  }
  return (
    <>
      <Tip
        label={t('site.download')}
        side="bottom"
        render={
          <button
            type="button"
            className={toggle.toggle}
            aria-label={t('site.download')}
            onPointerEnter={() => { void latestDesktopRelease().catch(() => {}) }}
            onClick={() => setOpen(true)}
          >
            <Download size={18} aria-hidden="true" />
          </button>
        }
      />
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={version ? <>{t('site.downloadTitle')} <DiaText className={styles.version}>{version}</DiaText></> : t('site.downloadTitle')}
        closeLabel={t('account.close')}
      >
        <ul className={styles.perks}>
          <li><span className={styles.perkIcon}><Zap size={18} aria-hidden="true" /></span>{t('site.perkTorrent')}</li>
          <li><span className={styles.perkIcon}><YoutubeGlyph size={18} /></span>{t('site.perkYoutube')}</li>
          <li><span className={styles.perkIcon}><Cpu size={18} aria-hidden="true" /></span>{t('site.perkLocal')}</li>
        </ul>
        {release.status === 'loading' ? (
          <Loading label={t('site.downloadLoading')} className={styles.grid}>
            {platforms.map(({ id }) => <Skeleton key={id} width="100%" height="auto" className={styles.skeleton} />)}
          </Loading>
        ) : (
          <div className={styles.grid}>
            {platforms.map(({ id, name, file, Glyph }) => {
              const href = hrefFor(id, file)
              const face = (
                <>
                  <Glyph size={32} />
                  <span>{name}</span>
                </>
              )
              return href ? (
                <a key={id} className={styles.platform} data-mine={id === mine || undefined} href={href} download onClick={() => setOpen(false)}>
                  {face}
                </a>
              ) : (
                <Tip key={id} label={t('site.downloadSoon')} render={<span className={styles.platform} aria-disabled="true" />}>
                  {face}
                </Tip>
              )
            })}
          </div>
        )}
        <p className={styles.optional}>{t('site.downloadOptional')}</p>
      </Modal>
    </>
  )
}
