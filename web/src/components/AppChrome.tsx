/**
 * The desktop app's title bar, drawn by the page: the app hands it over on
 * macOS (the traffic lights float over the header's corner) and on Windows
 * (the page draws minimise, maximise and close in the top-right corner).
 * The root carries `data-app-chrome` so headers keep clear of that corner,
 * and any header marked `data-tauri-drag-region` moves the window.
 */
import { Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { appChrome, desktop, type AppChrome as Chrome, type DesktopApp } from '../platform'
import { Tip } from '../ui/Tip'
import styles from './AppChrome.module.css'

export function AppChrome() {
  const t = useT()
  const [app, setApp] = useState<DesktopApp | null>(null)
  const [chrome, setChrome] = useState<Chrome | null>(null)

  useEffect(() => {
    let live = true
    void desktop().then((found) => {
      if (!live) return
      setApp(found)
      setChrome(appChrome(found))
    })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!chrome) return
    const root = document.documentElement
    root.dataset.appChrome = chrome
    return () => { delete root.dataset.appChrome }
  }, [chrome])

  if (!chrome || !app) return null
  const window = (cmd: 'minimize' | 'toggle_maximize' | 'close') => () => {
    void app.invoke(`plugin:window|${cmd}`, { label: 'main' }).catch(() => undefined)
  }
  return (
    <>
      <div className={styles.drag} data-tauri-drag-region aria-hidden="true" />
      {chrome === 'windows' ? (
        <div className={styles.buttons}>
          <Tip label={t('app.minimize')} side="bottom" render={<button type="button" className={styles.button} onClick={window('minimize')} />}>
            <Minus size={16} strokeWidth={1.25} />
          </Tip>
          <Tip label={t('app.maximize')} side="bottom" render={<button type="button" className={styles.button} onClick={window('toggle_maximize')} />}>
            <Square size={13} strokeWidth={1.25} />
          </Tip>
          <Tip label={t('app.close')} side="bottom" render={<button type="button" className={`${styles.button} ${styles.close}`} onClick={window('close')} />}>
            <X size={17} strokeWidth={1.25} />
          </Tip>
        </div>
      ) : null}
    </>
  )
}
