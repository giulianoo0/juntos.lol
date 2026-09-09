import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Gauge, MonitorUp, Replace } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { JLOCAL_ORIGIN } from '../jlocal/status'
import { getCachedJLocalCapabilities } from '../jlocal/capabilities'
import { useSoundChoice } from '../jlocal/soundChoice'
import { Button } from '../ui/Button'
import { SoundMenu } from './SoundMenu'
import { MorphingMenu } from '../ui/MorphingMenu'
import { MORPH_EASE } from '../ui/morphTokens'
import { loadScreenQuality, screenQuality, type ScreenQualityId } from '../screenshare'
import { jlocalQualities } from '../jlocal/qualities'
import type { JlocalPick } from './useScreenShare'

/**
 * Choosing what the jlocal companion captures: displays or windows as live
 * thumbnails, the same quality presets the browser path offers (trimmed to
 * what the app can do), and the system sound as one switch. It is a panel,
 * not a dialog, so the home page can hold it inside its morphing card and the
 * room can wrap it in one.
 */

interface Target {
  id: string
  name: string
  app: string
  icon: string
  width: number
  height: number
}

type Tab = 'displays' | 'windows'

const THUMB_WIDTH = 480
/** The selected thumbnail stays live at this cadence; the rest are one shot. */
const LIVE_THUMB_MS = 1_000

function parseTargets(body: unknown, key: string): Target[] {
  const list = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(list)) return []
  const targets: Target[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, width, height, app, icon } = entry as Record<string, unknown>
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue
    if (typeof width !== 'number' || typeof height !== 'number') continue
    targets.push({
      id: String(id),
      name,
      app: typeof app === 'string' ? app : '',
      icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon : '',
      width,
      height,
    })
  }
  return targets
}

function Thumb({ target, kind, live, t }: { target: Target; kind: Tab; live: boolean; t: Translator }) {
  const [src, setSrc] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const param = kind === 'windows' ? 'window_id' : 'display_id'
  const base = `${JLOCAL_ORIGIN}/capture/snapshot?${param}=${encodeURIComponent(target.id)}&width=${THUMB_WIDTH}`
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let tick = 0
    const load = () => {
      if (cancelled || document.hidden) { if (live) timer = window.setTimeout(load, LIVE_THUMB_MS); return }
      tick += 1
      const url = `${base}&t=${tick}`
      const probe = new Image()
      probe.onload = () => {
        if (cancelled) return
        setSrc(url)
        if (live) timer = window.setTimeout(load, LIVE_THUMB_MS)
      }
      probe.onerror = () => {
        if (cancelled) return
        void fetch(base).then((r) => { if (r.status === 503) setDenied(true) }).catch(() => undefined)
        if (live) timer = window.setTimeout(load, LIVE_THUMB_MS * 2)
      }
      probe.src = url
    }
    load()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [base, live])
  return (
    <span className="jpick-thumb" aria-hidden="true">
      {src && !denied ? <img src={src} alt="" /> : <span className="jpick-shimmer" title={denied ? t('jlocal.permission') : undefined} />}
    </span>
  )
}

export function JlocalPicker({ onPick, onExit, busy = false, error = null, mode = 'start', t }: {
  onPick: (pick: JlocalPick) => void
  onExit: () => void
  busy?: boolean
  error?: string | null
  /** `switch` is the same panel during a share: the button swaps the surface instead of starting one. */
  mode?: 'start' | 'switch'
  t: Translator
}) {
  const still = useReducedMotion() ?? false
  const [tab, setTab] = useState<Tab>('displays')
  const [lists, setLists] = useState<Record<Tab, Target[] | null | 'failed'>>({ displays: null, windows: null })
  const [picked, setPicked] = useState<Record<Tab, string | null>>({ displays: null, windows: null })
  const qualities = useMemo(jlocalQualities, [])
  const [quality, setQuality] = useState<ScreenQualityId>(() => {
    const saved = loadScreenQuality()
    return qualities.includes(saved) ? saved : qualities.includes('1080p60') ? '1080p60' : qualities[qualities.length - 1]
  })
  const audioCapture = getCachedJLocalCapabilities()?.audio.capture === true
  const sound = useSoundChoice().enabled
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (lists[tab] !== null) return
    let cancelled = false
    const key = tab === 'displays' ? 'displays' : 'windows'
    void fetch(`${JLOCAL_ORIGIN}/capture/${key}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        const found = parseTargets(await response.json(), key)
        if (cancelled) return
        setLists((all) => ({ ...all, [tab]: found }))
        setPicked((all) => (all[tab] ?? found[0]?.id) === all[tab] ? all : { ...all, [tab]: found[0]?.id ?? null })
      })
      .catch(() => { if (!cancelled) setLists((all) => ({ ...all, [tab]: 'failed' })) })
    return () => { cancelled = true }
  }, [tab, lists])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (panelRef.current && !panelRef.current.contains(event.target as Node | null)) return
      onExit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  const current = lists[tab]
  const selected = picked[tab]
  const canShare = Array.isArray(current) && current.length > 0 && selected !== null && !busy
  const swap = still ? { duration: 0 } : { duration: 0.22, ease: MORPH_EASE }
  const label = (id: ScreenQualityId) => screenQuality(id).label

  const share = () => {
    if (!canShare || selected === null) return
    onPick({ target: { kind: tab === 'windows' ? 'window' : 'display', id: selected }, quality, audio: audioCapture && sound })
  }

  return (
    <div ref={panelRef} className="jpick">
      <div className="jpick-tabs" role="tablist" aria-label={t('jlocal.pickTitle')}>
        {(['displays', 'windows'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>
            {tab === value ? <motion.span layoutId="jpick-tab" className="season-pill" transition={still ? { duration: 0 } : { type: 'spring', duration: 0.45, bounce: 0.2 }} /> : null}
            <span className="season-tab-label">{t(value === 'displays' ? 'jlocal.tabDisplays' : 'jlocal.tabWindows')}</span>
          </button>
        ))}
      </div>
      <div className="jpick-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={still ? false : { opacity: 0, filter: 'blur(3px)', y: 4 }}
            animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
            exit={{ opacity: 0, filter: 'blur(3px)', y: -4 }}
            transition={swap}
          >
            {current === null ? <p className="jpick-note">{t('jlocal.loading')}</p>
              : current === 'failed' || current.length === 0 ? <p className="jpick-note">{t('jlocal.empty')}</p>
              : (
                <div className="jpick-grid" role="radiogroup">
                  {current.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      role="radio"
                      aria-checked={target.id === selected}
                      className={`jpick-card ${target.id === selected ? 'is-selected' : ''}`}
                      onClick={() => setPicked((all) => ({ ...all, [tab]: target.id }))}
                      onDoubleClick={share}
                    >
                      <Thumb target={target} kind={tab} live={target.id === selected} t={t} />
                      <span className="jpick-meta">
                        {target.icon ? <img className="jpick-icon" src={target.icon} alt="" aria-hidden="true" /> : null}
                        <span className="jpick-name">
                          <strong>{target.name}</strong>
                          <small>{target.app ? `${target.app} · ` : ''}{target.width}×{target.height}</small>
                        </span>
                        {target.id === selected ? <Check size={14} aria-hidden="true" style={{ color: 'var(--primary)' }} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
          </motion.div>
        </AnimatePresence>
      </div>
      {error ? <p className="jpick-error" role="alert">{error}</p> : null}
      <div className="jpick-bar">
        <MorphingMenu
          align="start"
          haspopup="listbox"
          minWidth={0}
          ariaLabel={t('room.screenQuality')}
          triggerClassName="screen-quality-pill"
          trigger={() => <><Gauge size={14} aria-hidden="true" />{label(quality)}</>}
        >
          {(close) => (
            <div className="screen-quality-menu" role="listbox" aria-label={t('room.screenQuality')}>
              {qualities.map((id) => (
                <button key={id} type="button" role="option" aria-selected={id === quality} onClick={() => { close(); setQuality(id) }}>
                  {label(id)}
                  {id === quality ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          )}
        </MorphingMenu>
        {audioCapture ? <SoundMenu t={t} /> : null}
        <span className="spacer" />
        <Button variant="primary" disabled={!canShare} onClick={share}>
          {mode === 'switch' ? <Replace size={15} aria-hidden="true" /> : <MonitorUp size={15} aria-hidden="true" />}
          {t(mode === 'switch' ? 'jlocal.switch' : 'jlocal.share')}
        </Button>
      </div>
    </div>
  )
}
