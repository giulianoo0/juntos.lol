import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion'
import { motion, useReducedMotion } from 'motion/react'
import { Loader2, MessageSquareShare, Star, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { fetchMeta, type MetaDetail, type MetaVideo } from './cinemeta'
import { fetchStreams, type CatalogStream, type StreamResolution, type StreamTarget } from './streams'
import type { TitleOpen } from './PosterCard'

// The poster card's corner radius — the morph starts here and grows into the
// panel's own radius.
const CARD_RADIUS = '14px'
const MORPH_EASE: [number, number, number, number] = [0.77, 0, 0.175, 1]
const REVEAL_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]

export type DetailsMode = 'create' | 'host' | 'viewer'

export interface TitlePick {
  stream: CatalogStream
  target: StreamTarget
  displayName: string
}

interface MetaDetailsProps {
  open: TitleOpen
  mode: DetailsMode
  // Pre-selects an episode, so the host can land straight on a viewer's ask.
  focus?: { season: number; episode: number }
  onClose: () => void
  onPickStream: (pick: TitlePick) => void
  onRequestTitle?: (request: { season?: number; episode?: number }) => void
}

// The details panel. It morphs out of the clicked poster (FLIP: mounted at
// the poster's rect, grown into its resting layout), reveals its content only
// once the morph lands, and shrinks back into the card on close. Without an
// origin rect — deep links, keyboard opens, reduced motion — it fades.
export function MetaDetails({ open, mode, focus, onClose, onPickStream, onRequestTitle }: MetaDetailsProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const [revealed, setRevealed] = useState(false)
  const [detail, setDetail] = useState<MetaDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [season, setSeason] = useState(focus?.season ?? 1)
  const [selected, setSelected] = useState<MetaVideo | null>(null)
  const [streams, setStreams] = useState<CatalogStream[] | null>(null)
  const [streamsFailed, setStreamsFailed] = useState(false)
  const [resolutionFilter, setResolutionFilter] = useState<'all' | StreamResolution>('all')
  // A flag emoji, or 'all'. A flag matches releases carrying the language as
  // audio or as subtitles alike — Torrentio lists it either way.
  const [languageFilter, setLanguageFilter] = useState('all')
  const [requested, setRequested] = useState(false)
  const meta = open.meta
  const morphs = Boolean(open.rect) && !reduceMotion

  useEffect(() => {
    let cancelled = false
    fetchMeta(meta.type, meta.id)
      .then((value) => {
        if (cancelled) return
        setDetail(value)
        setDetailFailed(value === null)
      })
      .catch(() => { if (!cancelled) setDetailFailed(true) })
    return () => { cancelled = true }
  }, [meta.id, meta.type])

  // Series wait for an episode pick; movies list their streams immediately.
  const target: StreamTarget | null = useMemo(() => {
    if (meta.type === 'movie') return { type: 'movie', id: meta.id }
    if (selected) return { type: 'series', id: meta.id, season: selected.season, episode: selected.episode }
    return null
  }, [meta.id, meta.type, selected])

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setStreams(null)
    setStreamsFailed(false)
    fetchStreams(target)
      .then((value) => { if (!cancelled) setStreams(value) })
      .catch(() => { if (!cancelled) setStreamsFailed(true) })
    return () => { cancelled = true }
  }, [target])

  const seasons = useMemo(() => {
    const numbers = new Set<number>()
    for (const video of detail?.videos ?? []) {
      if (video.season > 0) numbers.add(video.season)
    }
    return [...numbers].sort((a, b) => a - b)
  }, [detail])

  const episodes = useMemo(
    () => (detail?.videos ?? []).filter((video) => video.season === season).sort((a, b) => a.episode - b.episode),
    [detail, season],
  )

  // Deep-linked focus lands on the asked-for episode as soon as it exists.
  useEffect(() => {
    if (!focus || !detail) return
    const match = detail.videos.find((video) => video.season === focus.season && video.episode === focus.episode)
    if (match) {
      setSeason(match.season)
      setSelected(match)
    }
  }, [focus, detail])

  // Open morph: measure the resting layout, jump back onto the poster's rect,
  // then grow into place. The geometry goes back to CSS afterwards so the
  // resting panel stays responsive.
  useEffect(() => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || !backdrop) return
    const backdropIn = animate(backdrop, { opacity: [0, 1] }, { duration: 0.25, ease: REVEAL_EASE })
    if (!morphs || !open.rect) {
      const fade = reduceMotion
        ? animate(panel, { opacity: [0, 1] }, { duration: 0.2, ease: REVEAL_EASE })
        : animate(panel, { opacity: [0, 1], transform: ['scale(0.97)', 'scale(1)'] }, { duration: 0.25, ease: REVEAL_EASE })
      setRevealed(true)
      return () => { backdropIn.stop(); fade.stop() }
    }
    const final = panel.getBoundingClientRect()
    const finalRadius = window.getComputedStyle(panel).borderTopLeftRadius || '0px'
    const origin = open.rect
    Object.assign(panel.style, {
      position: 'fixed',
      margin: '0',
      top: `${origin.top}px`,
      left: `${origin.left}px`,
      width: `${origin.width}px`,
      height: `${origin.height}px`,
      borderRadius: CARD_RADIUS,
    })
    const morph = animate(
      panel,
      {
        top: [`${origin.top}px`, `${final.top}px`],
        left: [`${origin.left}px`, `${final.left}px`],
        width: [`${origin.width}px`, `${final.width}px`],
        height: [`${origin.height}px`, `${final.height}px`],
        borderRadius: [CARD_RADIUS, finalRadius],
      },
      { duration: 0.42, ease: MORPH_EASE },
    )
    void morph.then(() => {
      for (const property of ['position', 'margin', 'top', 'left', 'width', 'height', 'borderRadius']) {
        panel.style.removeProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))
      }
      setRevealed(true)
    })
    return () => { backdropIn.stop(); morph.stop() }
    // The morph runs once, from the rect the panel was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close: shrink back into the poster. The origin only stays honest while
  // the page behind has not scrolled; the backdrop blocks that, so the rect
  // captured at open time is still where the card sits.
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || !backdrop) {
      onClose()
      return
    }
    const fadeOut = animate(backdrop, { opacity: 0 }, { duration: 0.25, ease: REVEAL_EASE })
    if (!morphs || !open.rect) {
      void animate(panel, { opacity: 0 }, { duration: 0.15, ease: REVEAL_EASE }).then(onClose)
      return
    }
    const rect = panel.getBoundingClientRect()
    const radius = window.getComputedStyle(panel).borderTopLeftRadius || '0px'
    Object.assign(panel.style, {
      position: 'fixed',
      margin: '0',
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderRadius: radius,
      overflow: 'hidden',
    })
    setRevealed(false)
    const origin = open.rect
    void fadeOut
    void animate(
      panel,
      {
        top: `${origin.top}px`,
        left: `${origin.left}px`,
        width: `${origin.width}px`,
        height: `${origin.height}px`,
        borderRadius: CARD_RADIUS,
        opacity: [1, 1, 0.6],
      },
      { duration: 0.32, ease: MORPH_EASE },
    ).then(onClose)
  }, [morphs, onClose, open.rect])

  // Escape closes; the page behind must not scroll while the panel is up.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [requestClose])

  const resolutionOptions = useMemo(
    () => [...new Set((streams ?? []).map((stream) => stream.resolution))],
    [streams],
  )
  const languageOptions = useMemo(
    () => [...new Set((streams ?? []).flatMap((stream) => stream.languages))].sort(),
    [streams],
  )
  const visibleStreams = useMemo(
    () => (streams ?? []).filter((stream) => (
      (resolutionFilter === 'all' || stream.resolution === resolutionFilter) &&
      (languageFilter === 'all' || stream.languages.includes(languageFilter))
    )),
    [streams, resolutionFilter, languageFilter],
  )

  const requestEpisode = () => {
    onRequestTitle?.(selected ? { season: selected.season, episode: selected.episode } : {})
    setRequested(true)
  }

  const reveal = revealed
    ? { opacity: 1, transform: 'translateY(0px)' }
    : { opacity: 0, transform: reduceMotion ? 'translateY(0px)' : 'translateY(20px)' }

  const background = detail?.background || ''
  const year = detail?.releaseInfo || meta.releaseInfo

  return (
    <div className="details-layer" role="presentation">
      <div ref={backdropRef} className="details-backdrop" onClick={requestClose} />
      <div ref={panelRef} className="details-panel raised" role="dialog" aria-modal="true" aria-label={meta.name} tabIndex={-1}>
        <div className="details-hero" style={background ? { backgroundImage: `url(${background})` } : undefined}>
          {!background && meta.poster ? <img className="details-hero-poster" src={meta.poster} alt="" /> : null}
          <div className="details-hero-scrim" />
        </div>
        <motion.div
          className="details-content"
          initial={false}
          animate={reveal}
          transition={{ duration: 0.3, ease: REVEAL_EASE }}
        >
          <button type="button" className="dialog-close details-close" aria-label={t('details.close')} onClick={requestClose}>
            <X size={16} aria-hidden="true" />
          </button>
          <h2>{detail?.name ?? meta.name}</h2>
          <p className="details-meta-line">
            {year ? <span>{year}</span> : null}
            {detail?.runtime ? <span>{detail.runtime}</span> : null}
            {detail?.imdbRating ? (
              <span className="details-rating"><Star size={13} aria-hidden="true" />{detail.imdbRating}</span>
            ) : null}
            {detail?.genres.length ? <span>{detail.genres.slice(0, 3).join(' · ')}</span> : null}
          </p>
          {detail?.description ? <p className="details-description">{detail.description}</p> : null}
          {detail?.cast.length ? (
            <p className="details-cast">{t('details.cast')}: {detail.cast.slice(0, 5).join(', ')}</p>
          ) : null}
          {detailFailed ? <p className="empty-copy">{t('details.metaFailed')}</p> : null}

          {meta.type === 'series' ? (
            <div className="details-episodes">
              <div className="details-season-row">
                <label htmlFor="details-season">{t('details.season')}</label>
                <select
                  id="details-season"
                  value={season}
                  onChange={(event) => { setSeason(Number(event.target.value)); setSelected(null) }}
                >
                  {(seasons.length > 0 ? seasons : [season]).map((value) => (
                    <option key={value} value={value}>{t('details.seasonN')} {value}</option>
                  ))}
                </select>
              </div>
              <div className="details-episode-list">
                {episodes.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    className={selected?.id === video.id ? 'is-selected' : ''}
                    onClick={() => setSelected(video)}
                  >
                    <span className="episode-number">{video.episode}</span>
                    <span className="episode-name">{video.name || `${t('details.episode')} ${video.episode}`}</span>
                  </button>
                ))}
                {detail && episodes.length === 0 ? <p className="empty-copy">{t('details.noEpisodes')}</p> : null}
              </div>
            </div>
          ) : null}

          {mode === 'viewer' ? (
            <div className="details-request">
              <button
                type="button"
                className="primary-button raised"
                disabled={requested || (meta.type === 'series' && !selected)}
                onClick={requestEpisode}
              >
                <MessageSquareShare size={16} aria-hidden="true" />
                {requested ? t('details.requested') : t('details.requestHost')}
              </button>
              {meta.type === 'series' && !selected ? <p className="empty-copy">{t('details.pickEpisodeFirst')}</p> : null}
            </div>
          ) : target ? (
            <div className="details-streams">
              <div className="details-streams-head">
                <h3>{t('details.sources')}</h3>
                {streams && streams.length > 0 ? (
                  <div className="stream-filters">
                    <label>
                      <span className="sr-only">{t('details.quality')}</span>
                      <select value={resolutionFilter} onChange={(event) => setResolutionFilter(event.target.value as 'all' | StreamResolution)}>
                        <option value="all">{t('details.allQualities')}</option>
                        {resolutionOptions.map((value) => (
                          <option key={value} value={value}>{value === 'sd' ? 'SD' : value}</option>
                        ))}
                      </select>
                    </label>
                    {languageOptions.length > 0 ? (
                      <label>
                        <span className="sr-only">{t('details.language')}</span>
                        <select value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value)}>
                          <option value="all">{t('details.allLanguages')}</option>
                          {languageOptions.map((flag) => (
                            <option key={flag} value={flag}>{flag} {t('details.dubOrSub')}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {streams === null && !streamsFailed ? (
                <p className="details-streams-loading"><Loader2 className="details-spin" size={15} aria-hidden="true" />{t('details.loadingSources')}</p>
              ) : streamsFailed || streams === null ? (
                <p className="empty-copy">{t('details.sourcesFailed')}</p>
              ) : streams.length === 0 ? (
                <p className="empty-copy">{t('details.noSources')}</p>
              ) : visibleStreams.length === 0 ? (
                <p className="empty-copy">{t('details.noFilteredSources')}</p>
              ) : (
                <div className="stream-list">
                  {visibleStreams.slice(0, 30).map((stream) => (
                    <button
                      key={stream.infoHash + stream.fileName}
                      type="button"
                      onClick={() => onPickStream({
                        stream,
                        target,
                        displayName: selected
                          ? `${meta.name} S${String(selected.season).padStart(2, '0')}E${String(selected.episode).padStart(2, '0')}`
                          : meta.name,
                      })}
                    >
                      <span className="stream-quality">{stream.quality}</span>
                      <span className="stream-label">{stream.label}</span>
                      <span className="stream-facts">
                        {stream.languages.length > 0 ? <span>{stream.languages.slice(0, 6).join(' ')}</span> : null}
                        {stream.seeders !== null ? <span>{stream.seeders} seeds</span> : null}
                        {stream.size ? <span>{stream.size}</span> : null}
                        {stream.source ? <span>{stream.source}</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : meta.type === 'series' ? (
            <p className="empty-copy">{t('details.pickEpisode')}</p>
          ) : null}
        </motion.div>
      </div>
    </div>
  )
}
