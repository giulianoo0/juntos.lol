import { Moon, Sun } from 'lucide-react'
import { useT } from '../i18n/useT'
import { useTheme } from './theme'
import { useMediaQuery } from './useMediaQuery'
import { Tip } from './Tip'
import styles from './ThemeToggle.module.css'

/** Light or dark, from whatever is showing now; the system decides until it is pressed. */
export function ThemeToggle() {
  const t = useT()
  const { theme, setTheme } = useTheme()
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  const label = t(dark ? 'theme.light' : 'theme.dark')
  return (
    <Tip
      label={label}
      side="bottom"
      render={
        <button type="button" className={styles.toggle} aria-label={label} onClick={() => setTheme(dark ? 'light' : 'dark')}>
          <span key={dark ? 'moon' : 'sun'} className={styles.glyph} aria-hidden="true">
            {dark ? <Moon size={18} /> : <Sun size={18} />}
          </span>
        </button>
      }
    />
  )
}
