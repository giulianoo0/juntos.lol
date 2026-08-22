import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Puzzle, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { CatalogBrowser } from './CatalogBrowser'
import { ProgressiveBlur } from './ProgressiveBlur'
import { PluginsPanel } from '../plugins/PluginsPanel'
import { MetaDetails, type DetailsMode, type TitlePick } from './MetaDetails'
import type { TitleOpen } from './PosterCard'

export interface OverlayFocus {
  open: TitleOpen
  season?: number
  episode?: number
}

interface CatalogOverlayProps {
  mode: Exclude<DetailsMode, 'create'>
  // Jump straight into one title's details — how the host lands on the exact
  // episode a viewer asked for.
  focus?: OverlayFocus | null
  onClose: () => void
  onPickStream: (pick: TitlePick) => void
  onRequestTitle: (open: TitleOpen, episode: { season?: number; episode?: number }) => void
}

// The in-room catalog: a full-screen layer over the player. Browsing here is
// local — nothing about navigation crosses the wire; only the host's source
// swap or a viewer's title request does.
export function CatalogOverlay({ mode, focus, onClose, onPickStream, onRequestTitle }: CatalogOverlayProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const [details, setDetails] = useState<TitleOpen | null>(focus?.open ?? null)
  const [pluginsOpen, setPluginsOpen] = useState(false)

  // "Ver fontes" on a request card must land here even when the overlay is
  // already open; `focus` is parent state, so its identity only changes when
  // a new request is opened.
  useEffect(() => {
    if (focus) setDetails(focus.open)
  }, [focus])

  // Escape only closes the overlay when the details panel is not up — the
  // panel handles its own Escape and stops there being two layers vanishing.
  useEffect(() => {
    if (details) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [details, onClose])

  return (
    <motion.div
      className="catalog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('catalog.tab')}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.98)' }}
      animate={{ opacity: 1, transform: 'scale(1)' }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
    >
      <header className="catalog-overlay-head">
        <ProgressiveBlur />
        <h1>{t('catalog.tab')}</h1>
        <button type="button" className="header-plugins" onClick={() => setPluginsOpen(true)}>
          <Puzzle size={15} aria-hidden="true" />{t('plugins.open')}
        </button>
        <button type="button" className="dialog-close" aria-label={t('details.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="catalog-overlay-body">
        <CatalogBrowser compact onOpenTitle={setDetails} hideSearch={details !== null} />
      </div>
      {details ? (
        <MetaDetails
          onOpenPlugins={() => setPluginsOpen(true)}
          key={`${details.meta.type}:${details.meta.id}`}
          open={details}
          mode={mode}
          focus={focus && focus.open.meta.id === details.meta.id && focus.season != null && focus.episode != null
            ? { season: focus.season, episode: focus.episode }
            : undefined}
          onClose={() => setDetails(null)}
          onPickStream={onPickStream}
          onRequestTitle={(episode) => onRequestTitle(details, episode)}
        />
      ) : null}

      <PluginsPanel open={pluginsOpen} onClose={() => setPluginsOpen(false)} />
    </motion.div>
  )
}
