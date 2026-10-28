import { useT } from '../i18n/useT'
import { GITHUB_URL, GithubGlyph } from './GithubGlyph'
import { Tip } from './Tip'
import styles from './ThemeToggle.module.css'

/** The round way to the site's code, beside the light switch. */
export function GithubLink() {
  const t = useT()
  return (
    <Tip
      label={t('site.github')}
      side="bottom"
      render={
        <a className={styles.toggle} href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label={t('site.github')}>
          <GithubGlyph size={18} />
        </a>
      }
    />
  )
}
