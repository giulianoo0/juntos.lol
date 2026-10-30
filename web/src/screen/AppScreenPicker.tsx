import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Gauge, MonitorUp, Replace, Settings } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { appScreenPermitted, appSources, appThumbnail, guideAppScreenPermission, type AppSources } from '../desktop/screen'
import { useSoundChoice } from '../jlocal/soundChoice'
import { screenQuality, type ScreenQualityId } from '../screenshare'
import { Button } from '../ui/Button'
import { MorphingMenu } from '../ui/MorphingMenu'
import { Segmented } from '../ui/Segmented'
import { Loading, Skeleton } from '../ui/Shimmer'
import { APP_QUALITIES, initialAppQuality, useAppSoundApps } from './appShare'
import { AppSoundSwitches, MuteAllButton } from './AppSound'
import type { JlocalPick } from './useScreenShare'
import styles from './AppScreenPicker.module.css'

/**
 * Choosing what the desktop app shares: displays or windows as thumbnails
 * on the left, and on the right the sound, app by app with the system's own
 * icons, and the quality. Like the jlocal picker it is a panel, so the room
 * can hold it in its morphing card or in a dialog.
 */

export type AppPick = JlocalPick

type Tab = 'displays' | 'windows'

const THUMB_WIDTH = 480
/** Thumbnails follow the machine at this pace while the picker is open. */
const REFRESH_MS = 2_000
/** How often a picker waiting on Screen Recording asks again. */
const PERMISSION_MS = 1_000

interface Card {
  id: string
  name: string
  icon: string
}

function cardsFor(sources: AppSources | null, tab: Tab): Card[] | null {
  if (!sources) return null
  return tab === 'displays'
    ? sources.displays.map((display) => ({ id: display.id, name: display.name, icon: '' }))
    : sources.windows.map((window) => ({ id: window.id, name: window.title || window.app, icon: window.icon }))
}

/** Every thumbnail of the tab, taken again every couple of seconds while the picker is open. */
function useThumbnails(tab: Tab, cards: Card[] | null): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const ids = cards?.map((card) => card.id).join('\n') ?? ''
  useEffect(() => {
    if (!ids) return
    let cancelled = false
    const kind = tab === 'windows' ? 'window' : 'display'
    const load = () => {
      if (document.hidden) return
      for (const id of ids.split('\n')) {
        void appThumbnail(kind, id, THUMB_WIDTH).then((src) => {
          if (!cancelled && src) setThumbs((all) => (all[`${kind}:${id}`] === src ? all : { ...all, [`${kind}:${id}`]: src }))
        })
      }
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [tab, ids])
  return thumbs
}

/** null while asking; false keeps asking every second until the OS says yes. */
function useScreenPermission(): boolean | null {
  const [permitted, setPermitted] = useState<boolean | null>(null)
  useEffect(() => {
    if (permitted) return
    let cancelled = false
    const ask = () => { void appScreenPermitted().then((yes) => { if (!cancelled) setPermitted(yes) }) }
    if (permitted === null) ask()
    const timer = window.setInterval(ask, PERMISSION_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [permitted])
  return permitted
}

export function AppScreenPicker({ onPick, onExit, busy = false, error = null, mode = 'start', t }: {
  onPick: (pick: AppPick) => void
  onExit: () => void
  busy?: boolean
  error?: string | null
  /** `switch` is the same panel during a share: the button swaps the surface instead of starting one. */
  mode?: 'start' | 'switch'
  t: Translator
}) {
  const [tab, setTab] = useState<Tab>('displays')
  const [sources, setSources] = useState<AppSources | null>(null)
  const [picked, setPicked] = useState<Record<Tab, string | null>>({ displays: null, windows: null })
  const [quality, setQuality] = useState<ScreenQualityId>(initialAppQuality)
  const choice = useSoundChoice()
  const apps = useAppSoundApps(true)
  const panelRef = useRef<HTMLDivElement>(null)
  const soundTitle = useId()

  const permitted = useScreenPermission()

  useEffect(() => {
    if (!permitted) return
    let cancelled = false
    void appSources().then((found) => {
      if (cancelled) return
      setSources(found)
      setPicked({ displays: found.displays[0]?.id ?? null, windows: found.windows[0]?.id ?? null })
    })
    return () => { cancelled = true }
  }, [permitted])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (panelRef.current && !panelRef.current.contains(event.target as Node | null)) return
      onExit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  const cards = useMemo(() => cardsFor(sources, tab), [sources, tab])
  const thumbs = useThumbnails(tab, cards)
  const kind = tab === 'windows' ? 'window' : 'display'
  const selected = picked[tab]
  const canShare = cards !== null && cards.some((card) => card.id === selected) && !busy

  const share = () => {
    if (!canShare || selected === null) return
    onPick({ target: { kind, id: selected }, quality, audio: choice.enabled })
  }

  return (
    <div ref={panelRef} className={styles.picker}>
      <div className={styles.sources}>
        <Segmented
          label={t('appScreen.sources')}
          className={styles.tabs}
          value={tab}
          onChange={setTab}
          options={[{ value: 'displays', label: t('jlocal.tabDisplays') }, { value: 'windows', label: t('jlocal.tabWindows') }]}
        />
        <div className={styles.scroll}>
          {permitted === false ? (
            <div className={styles.permission}>
              <p>{t('appScreen.permissionTitle')}</p>
              <Button variant="primary" onClick={() => { void guideAppScreenPermission().catch(() => undefined) }}>
                <Settings size={15} aria-hidden="true" />
                {t('appScreen.permissionOpen')}
              </Button>
            </div>
          ) : cards === null ? (
            <Loading label={t('status.loading')} className={styles.grid}>
              {[0, 1].map((index) => (
                <span key={index} className={styles.card}>
                  <Skeleton height="auto" style={{ aspectRatio: '16 / 9' }} />
                  <Skeleton width="60%" height="0.75rem" />
                </span>
              ))}
            </Loading>
          ) : cards.length === 0 ? <p className={styles.empty}>{t('jlocal.empty')}</p> : (
            <div className={styles.grid} role="radiogroup" aria-label={t('appScreen.sources')}>
              {cards.map((card) => {
                const src = thumbs[`${kind}:${card.id}`]
                return (
                  <button
                    key={card.id}
                    type="button"
                    role="radio"
                    aria-checked={card.id === selected}
                    className={styles.card}
                    onClick={() => setPicked((all) => ({ ...all, [tab]: card.id }))}
                    onDoubleClick={share}
                  >
                    <span className={styles.thumb}>
                      {src ? <img src={src} alt="" /> : <Skeleton className={styles.thumbWait} height="100%" />}
                    </span>
                    <span className={styles.meta}>
                      {card.icon ? <img className={styles.cardIcon} src={card.icon} alt="" aria-hidden="true" /> : null}
                      <span className={styles.cardName}>{card.name}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <section className={styles.sound} aria-labelledby={soundTitle}>
        <header className={styles.soundHead}>
          <h3 id={soundTitle}>{t('appScreen.sound')}</h3>
          <MuteAllButton apps={apps} t={t} />
        </header>
        <div className={styles.soundList}>
          <AppSoundSwitches apps={apps} t={t} />
        </div>
        <footer className={styles.quality}>
          <span>{t('room.screenQuality')}</span>
          <MorphingMenu
            align="end"
            haspopup="listbox"
            minWidth={0}
            ariaLabel={t('room.screenQuality')}
            triggerClassName="screen-quality-pill"
            trigger={() => <><Gauge size={14} aria-hidden="true" />{screenQuality(quality).label}</>}
          >
            {(close) => (
              <div className="screen-quality-menu" role="listbox" aria-label={t('room.screenQuality')}>
                {APP_QUALITIES.map((id) => (
                  <button key={id} type="button" role="option" aria-selected={id === quality} onClick={() => { close(); setQuality(id) }}>
                    {screenQuality(id).label}
                    {id === quality ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            )}
          </MorphingMenu>
        </footer>
      </section>
      <div className={styles.actions}>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <Button variant="ghost" onClick={onExit}>{t('appScreen.cancel')}</Button>
        <Button variant="primary" disabled={!canShare} loading={busy} onClick={share}>
          {mode === 'switch' ? <Replace size={15} aria-hidden="true" /> : <MonitorUp size={15} aria-hidden="true" />}
          {t(mode === 'switch' ? 'appScreen.switch' : 'appScreen.share')}
        </Button>
      </div>
    </div>
  )
}
