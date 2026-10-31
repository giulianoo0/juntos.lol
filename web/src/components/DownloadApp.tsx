import { Cpu, Download, Zap } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'
import { useT } from '../i18n/useT'
import { isDesktop } from '../platform'
import { GITHUB_URL } from '../ui/GithubGlyph'
import { Modal } from '../ui/Modal'
import { AppleGlyph, LinuxGlyph, WindowsGlyph } from '../ui/PlatformGlyphs'
import { DiaText, Loading, Skeleton } from '../ui/Shimmer'
import { Tip } from '../ui/Tip'
import { YoutubeGlyph } from '../ui/YoutubeGlyph'
import toggle from '../ui/ThemeToggle.module.css'
import { latestAndroidRelease, latestDesktopRelease, type AndroidRelease, type DesktopRelease, type Platform } from './desktopRelease'
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

// One modal for the page: the header's button and a pick only the app can
// do (YouTube, in a browser) both open it.
let modalOpen = false
const modalListeners = new Set<() => void>()

function setOpen(open: boolean): void {
  if (modalOpen === open) return
  modalOpen = open
  for (const listener of modalListeners) listener()
}

/** Opens the download modal from anywhere; nothing happens inside the app. */
export function openDownloadApp(): void {
  if (!isDesktop()) setOpen(true)
}

function subscribeModal(listener: () => void): () => void {
  modalListeners.add(listener)
  return () => { modalListeners.delete(listener) }
}

/** An Android browser, not the Android app's own web views, which say so in their user agent. */
function androidBrowser(userAgent = navigator.userAgent): boolean {
  return /Android/i.test(userAgent) && !/JuntosApp\//.test(userAgent)
}

/** The apk straight from GitHub, beta while it is: there once a version is out. */
function AndroidDownload() {
  const t = useT()
  const [apk, setApk] = useState<AndroidRelease | null>(null)
  useEffect(() => {
    let live = true
    latestAndroidRelease().then((release) => { if (live) setApk(release) }, () => {})
    return () => { live = false }
  }, [])
  if (!apk) return null
  return (
    <a className={`${toggle.toggle} ${styles.apk}`} href={apk.url} download aria-label={t('site.download')}>
      <Download size={18} aria-hidden="true" />
      <span className={styles.beta}>{t('site.beta')}</span>
    </a>
  )
}

/** The round way to the app, beside the GitHub link: the desktop one in a computer's browser, the apk on Android; nothing on an iPhone or inside an app. */
export function DownloadApp() {
  const t = useT()
  if (isDesktop()) return null
  if (androidBrowser()) return <AndroidDownload />
  if (!currentPlatform()) return null
  return (
    <Tip
      label={t('site.download')}
      side="bottom"
      render={
        <button
          type="button"
          className={toggle.toggle}
          aria-label={t('site.download')}
          onPointerEnter={() => { void latestDesktopRelease().catch(() => {}) }}
          onClick={openDownloadApp}
        >
          <Download size={18} aria-hidden="true" />
        </button>
      }
    />
  )
}

/** The download modal, mounted once at the page's root. */
export function DownloadAppHost() {
  const t = useT()
  const open = useSyncExternalStore(subscribeModal, () => modalOpen, () => false)
  const release = useDesktopRelease(open)
  if (isDesktop()) return null
  const mine = currentPlatform()
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
  const version = release.status === 'ready' ? release.release?.version : undefined
  const hrefFor = (id: Platform, file: string): string | undefined => {
    if (release.status === 'failed') return `${FALLBACK}/${file}`
    if (release.status === 'ready') return release.release?.downloads[id]
    return undefined
  }
  return (
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
              <Tip key={id} label={t('site.downloadSoon')} render={<span className={styles.platform} aria-disabled="true" tabIndex={0} />}>
                {face}
              </Tip>
            )
          })}
        </div>
      )}
      <p className={styles.optional}>{t('site.downloadOptional')}</p>
    </Modal>
  )
}
