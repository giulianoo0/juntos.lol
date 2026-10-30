import { Download } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { useT } from '../i18n/useT'
import { GITHUB_URL } from '../ui/GithubGlyph'
import { Modal } from '../ui/Modal'
import { AppleGlyph, LinuxGlyph, WindowsGlyph } from '../ui/PlatformGlyphs'
import { Tip } from '../ui/Tip'
import toggle from '../ui/ThemeToggle.module.css'
import styles from './DownloadApp.module.css'

type Platform = 'mac' | 'windows' | 'linux'

const RELEASES = `${GITHUB_URL}/releases/latest/download`

/** Stable asset names the release workflow uploads to every GitHub release. */
const PLATFORMS: { id: Platform, name: string, file: string, Glyph: ComponentType<{ size?: number }> }[] = [
  { id: 'mac', name: 'macOS', file: 'Juntos.dmg', Glyph: AppleGlyph },
  { id: 'windows', name: 'Windows', file: 'Juntos-setup.exe', Glyph: WindowsGlyph },
  { id: 'linux', name: 'Linux', file: 'Juntos.AppImage', Glyph: LinuxGlyph },
]

export function currentPlatform(userAgent = navigator.userAgent): Platform | null {
  if (/iPhone|iPad|Android/i.test(userAgent)) return null
  if (/Mac/i.test(userAgent)) return 'mac'
  if (/Win/i.test(userAgent)) return 'windows'
  if (/Linux|X11/i.test(userAgent)) return 'linux'
  return null
}

/** The round way to the desktop app, beside the GitHub link; gone on phones, which have no app. */
export function DownloadApp() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const mine = currentPlatform()
  if (!mine) return null
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
  return (
    <>
      <Tip
        label={t('site.download')}
        side="bottom"
        render={
          <button type="button" className={toggle.toggle} aria-label={t('site.download')} onClick={() => setOpen(true)}>
            <Download size={18} aria-hidden="true" />
          </button>
        }
      />
      <Modal open={open} onOpenChange={setOpen} title={t('site.downloadTitle')} closeLabel={t('account.close')}>
        <div className={styles.grid}>
          {platforms.map(({ id, name, file, Glyph }) => (
            <a key={id} className={styles.platform} data-mine={id === mine || undefined} href={`${RELEASES}/${file}`} download>
              <Glyph size={32} />
              <span>{name}</span>
            </a>
          ))}
        </div>
      </Modal>
    </>
  )
}
