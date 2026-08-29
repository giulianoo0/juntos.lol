import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, Filter, MessageSquareShare, Play, PlugZap, Puzzle, SearchX, Star, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Dropdown } from './Dropdown'
import { languageName } from './languages'
import { Carousel } from './Carousel'
import { FadeImg } from './FadeImg'
import { useT } from '../i18n/useT'
import { fetchMeta, type MetaDetail, type MetaVideo } from './cinemeta'
import { isPlayable, streamKey, type CatalogStream, type StreamResolution, type StreamTarget } from './streams'
import { resolveStreams } from '../plugins/resolve'
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
  // The title's own identity, so the room can remember what is playing and
  // offer the next episode when this one ends.
  metaName: string
  poster: string
}

interface MetaDetailsProps {
  open: TitleOpen
  mode: DetailsMode
  // Pre-selects an episode, so the host can land straight on a viewer's ask.
  focus?: { season: number; episode: number }
  onClose: () => void
  onPickStream: (pick: TitlePick) => void
  onRequestTitle?: (request: { season?: number; episode?: number }) => void
  // Opens the plugins panel. Both empty states that a plugin would fix lead
  // here, so the answer is one click from the problem.
  onOpenPlugins?: () => void
}


/**
 * Um estado vazio das fontes. Sempre a mesma forma — ícone, o que aconteceu,
 * por que, e a única saída que faz sentido — porque a lista de fontes tem
 * quatro maneiras diferentes de vir vazia e cada uma pede uma ação diferente.
 * Uma frase solta obrigava a pessoa a deduzir qual dos quatro casos era o dela.
 */
function SourcesEmpty({ icon, title, hint, action }: {
  icon: React.ReactNode
  title: string
  hint: string
  action?: { label: string; onClick: () => void; primary?: boolean }
}) {
  return (
    <div className="sources-empty">
      <span className="sources-empty-icon" aria-hidden="true">{icon}</span>
      <strong className="sources-empty-title">{title}</strong>
      <p className="sources-empty-hint">{hint}</p>
      {action ? (
        // O mesmo controle do resto do app, não um botão só desta tela.
        <Button variant={action.primary ? 'primary' : 'default'} size="small" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}

// O painel de detalhes. Ele nasce do pôster clicado (FLIP: montado no rect do
// card e crescido até o layout de repouso) e só revela o conteúdo quando o
// morph pousa. Sem rect de origem — deep link, abertura por teclado, motion
// reduzido — ele entra com um fade. Fechar é sempre fade: quem clicou no X já
// decidiu sair, e refazer o caminho de volta só atrasa isso. No celular ele
// não morpha nunca: é uma folha que sobe do rodapé e desce por ali.
export function MetaDetails({ open, mode, focus, onClose, onPickStream, onRequestTitle, onOpenPlugins }: MetaDetailsProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const [revealed, setRevealed] = useState(false)
  const [detail, setDetail] = useState<MetaDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [detailRetry, setDetailRetry] = useState(0)
  const [season, setSeason] = useState(focus?.season ?? 1)
  const [selected, setSelected] = useState<MetaVideo | null>(null)
  const [streams, setStreams] = useState<CatalogStream[] | null>(null)
  const [streamsFailed, setStreamsFailed] = useState(false)
  // Distinct from an empty list: nothing is installed, which is fixable.
  const [noPlugins, setNoPlugins] = useState(false)
  // Named, because "they all broke" is not "they found nothing".
  const [brokenPlugins, setBrokenPlugins] = useState<string[]>([])
  // "Procurar de novo" refaz a consulta sem fechar o painel.
  const [streamRetry, setStreamRetry] = useState(0)
  // Vira true quando a arte larga terminou de decodificar; o pôster que a
  // segurava até ali é desmontado.
  const [artLoaded, setArtLoaded] = useState(false)
  const markArtLoaded = useCallback(() => setArtLoaded(true), [])
  const [resolutionFilter, setResolutionFilter] = useState<'all' | StreamResolution>('all')
  // A flag emoji, or 'all'. A flag matches releases carrying the language as
  // audio or as subtitles alike — Torrentio lists it either way.
  const [languageFilter, setLanguageFilter] = useState('all')
  const [requested, setRequested] = useState(false)
  const meta = open.meta
  // No celular o painel é uma folha que sobe do rodapé: um card de 118px
  // crescendo até a tela inteira é um gesto que não lê, e o pôster de origem
  // fica coberto pela própria folha antes de a animação acabar.
  const sheet = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches, [])
  const morphs = Boolean(open.rect) && !reduceMotion && !sheet

  useEffect(() => {
    let cancelled = false
    setDetailFailed(false)
    fetchMeta(meta.type, meta.id)
      .then((value) => {
        if (cancelled) return
        setDetail(value)
        setDetailFailed(value === null)
      })
      .catch(() => { if (!cancelled) setDetailFailed(true) })
    return () => { cancelled = true }
  }, [meta.id, meta.type, detailRetry])

  // Series wait for an episode pick; movies list their streams immediately.
  const target: StreamTarget | null = useMemo(() => {
    if (meta.type === 'movie') return { type: 'movie', id: meta.id }
    if (selected) return { type: 'series', id: meta.id, season: selected.season, episode: selected.episode }
    return null
  }, [meta.id, meta.type, selected])

  useEffect(() => {
    // A viewer never sees this list — they see the button that asks the host.
    // Resolving anyway would run plugins to build something the interface
    // throws away, and would make a viewer need a plugin installed, which
    // contradicts the whole design.
    if (!target || mode === 'viewer') return
    // An AbortController rather than a flag: a flag only stops us listening,
    // and leaves every worker this started running out its whole budget.
    const abort = new AbortController()
    let cancelled = false
    setStreams(null)
    setStreamsFailed(false)
    setNoPlugins(false)
    setBrokenPlugins([])
    resolveStreams(target, { signal: abort.signal })
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'no-plugins') {
          setNoPlugins(true)
          setStreams([])
          return
        }
        setStreams(result.streams)
        setBrokenPlugins(result.failed)
      })
      .catch(() => { if (!cancelled) setStreamsFailed(true) })
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [target, mode, streamRetry])

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

  // Deep-linked focus lands on the asked-for episode as soon as it exists —
  // once. The prop's identity is unstable across parent re-renders, and
  // re-applying it would snap the panel back over whatever the host picked.
  const focusAppliedRef = useRef(false)
  // The hero's blur is driven from the scroll handler; these hold the pending
  // frame and the radius already written, so neither is done twice.
  const blurFrameRef = useRef(0)
  const heroBlurRef = useRef(0)
  useEffect(() => {
    if (!focus || !detail || focusAppliedRef.current) return
    const match = detail.videos.find((video) => video.season === focus.season && video.episode === focus.episode)
    if (match) {
      focusAppliedRef.current = true
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
    // StrictMode mounts effects twice: the first run leaves the panel pinned
    // to the poster rect, and measuring through those inline styles would
    // make the "final" layout equal the origin. Start from a clean slate.
    panel.removeAttribute('style')
    const backdropIn = animate(backdrop, { opacity: [0, 1] }, { duration: 0.25, ease: REVEAL_EASE })
    if (!morphs || !open.rect) {
      const fade = reduceMotion
        ? animate(panel, { opacity: [0, 1] }, { duration: 0.2, ease: REVEAL_EASE })
        // A folha sobe do rodapé; no desktop sem rect de origem, ela só cresce.
        : sheet
          ? animate(panel, { transform: ['translateY(100%)', 'translateY(0%)'] }, { duration: 0.4, ease: MORPH_EASE })
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
    // The panel's width is animated, and everything inside it — the hero, the
    // season tabs, the episode carousel — re-resolves against it on every one
    // of the 25 frames. Pinning the contents to the width they will end at
    // leaves only the clip box moving; they are invisible until `revealed`
    // anyway, so there is nothing to see change.
    const content = panel.querySelector<HTMLElement>('.details-content')
    const hero = panel.querySelector<HTMLElement>('.details-hero')
    if (content) content.style.width = `${final.width}px`
    if (hero) hero.style.width = `${final.width}px`
    void morph.then(() => {
      content?.style.removeProperty('width')
      hero?.style.removeProperty('width')
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
    animate(backdrop, { opacity: 0 }, { duration: 0.25, ease: REVEAL_EASE })
    // Abre com morph, fecha com fade. Encolher de volta para o pôster obriga a
    // olhar o caminho inteiro de novo, e ninguém está esperando por isso na
    // saída — quem fecha já decidiu ir embora. A folha do celular é a exceção:
    // ela desce por onde subiu, que é o gesto que ela mesma prometeu.
    void (sheet
      ? animate(panel, { transform: 'translateY(100%)' }, { duration: 0.3, ease: MORPH_EASE })
      : animate(panel, { opacity: 0, transform: 'scale(0.985)' }, { duration: 0.22, ease: REVEAL_EASE })
    ).then(onClose)
  }, [sheet, onClose])

  // The panel takes focus once, when it opens. Not on every render: the
  // close callback comes from the page and is a new function on each of its
  // renders, and an effect keyed on it re-focused this panel on every
  // keystroke typed into the nickname dialog stacked above it — the dialog
  // then pulled focus back with the whole name selected, and the next key
  // replaced it.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  // Escape closes; the page behind must not scroll while the panel is up.
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        requestCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

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
    // The server enforces a per-member cooldown and drops extras silently;
    // re-enabling after it keeps a quick second ask from dying unseen.
    window.setTimeout(() => setRequested(false), 6000)
  }

  const reveal = revealed
    ? { opacity: 1, transform: 'translateY(0px)' }
    : { opacity: 0, transform: reduceMotion ? 'translateY(0px)' : 'translateY(20px)' }

  const background = detail?.background || ''
  const year = detail?.releaseInfo || meta.releaseInfo

  return (
    <div className="details-layer" role="presentation">
      <div ref={backdropRef} className="details-backdrop" onClick={requestClose} />
      <div
        ref={panelRef}
        className="details-panel raised"
        role="dialog"
        aria-modal="true"
        aria-label={meta.name}
        tabIndex={-1}
        // Scrolling the sources reads over the hero; blurring it with the
        // scroll keeps the copy legible without a heavy static scrim.
        //
        // A wheel reports 100+ scroll events a second and every distinct
        // radius re-rasterizes the whole 300px hero, images and all. One write
        // per frame, quantized to 2px steps, turns a continuous re-raster into
        // nine discrete ones — indistinguishable on a 16px ramp.
        onScroll={(event) => {
          const panel = event.currentTarget
          if (blurFrameRef.current) return
          blurFrameRef.current = requestAnimationFrame(() => {
            blurFrameRef.current = 0
            const radius = Math.min(Math.round(panel.scrollTop / 48) * 2, 16)
            if (radius === heroBlurRef.current) return
            heroBlurRef.current = radius
            panel.style.setProperty('--hero-blur', `${radius}px`)
          })
        }}
      >
        <div className="details-hero">
          {/* O pôster é só o que segura o hero até a arte larga chegar: ele já
              está no cache do card, então não custa nada. Assim que a arte
              termina de decodificar ele sai — antes disso as duas ficavam
              montadas para sempre, decodificadas e pintadas a cada frame do
              blur do scroll, uma delas sem nunca aparecer. */}
          {meta.poster && !artLoaded ? (
            <FadeImg className="details-hero-poster" src={meta.poster} alt="" />
          ) : null}
          {background ? (
            <FadeImg className="details-hero-img" src={background} alt="" overlay onReady={markArtLoaded} />
          ) : null}
          <div className="details-hero-scrim" />
        </div>
        <motion.div
          className="details-content"
          initial={false}
          animate={reveal}
          transition={{ duration: revealed ? 0.3 : 0.15, ease: REVEAL_EASE }}
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
          {detailFailed ? (
            <p className="empty-copy">
              {t('details.metaFailed')}{' '}
              <button type="button" className="catalog-retry" onClick={() => setDetailRetry((seq) => seq + 1)}>{t('catalog.retry')}</button>
            </p>
          ) : null}
          {/* Slow connections: the panel never sits empty — text and episode
              placeholders hold the layout until Cinemeta answers. */}
          {!detail && !detailFailed ? (
            <div className="details-skeleton" aria-hidden="true">
              <span className="text-skeleton" style={{ width: '70%' }} />
              <span className="text-skeleton" style={{ width: '52%' }} />
              {meta.type === 'series' ? (
                <div className="details-skeleton-episodes">
                  {Array.from({ length: 4 }, (_, index) => <span key={index} className="episode-skeleton" />)}
                </div>
              ) : null}
            </div>
          ) : null}

          <AnimatePresence mode="wait" initial={false}>
          {meta.type === 'series' && !detail && !detailFailed ? null : meta.type === 'series' && !selected ? (
            <motion.div
              key="episodes"
              className="details-episodes"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              transition={{ duration: 0.2, ease: REVEAL_EASE }}
            >
              <div className="details-season-row">
                <div className="season-tabs" role="tablist" aria-label={t('details.season')}>
                  {(seasons.length > 0 ? seasons : [season]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={value === season}
                      className={value === season ? 'is-active' : ''}
                      onClick={() => setSeason(value)}
                    >
                      {value === season ? (
                        <motion.span
                          layoutId="season-pill"
                          className="season-pill"
                          transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.45, bounce: 0.2 }}
                        />
                      ) : null}
                      <span className="season-tab-label">{seasons.length > 6 ? `T${value}` : `${t('details.seasonN')} ${value}`}</span>
                    </button>
                  ))}
                </div>
              </div>
              {episodes.length > 0 ? (
                <Carousel className="details-episode-carousel" prevLabel={t('catalog.scrollBack')} nextLabel={t('catalog.scrollForward')}>
                  {episodes.map((video) => (
                    <button
                      key={video.id}
                      type="button"
                      className="episode-card"
                      onClick={() => setSelected(video)}
                    >
                      {video.thumbnail ? <FadeImg className="episode-art" src={video.thumbnail} alt="" loading="lazy" /> : null}
                      <span className="episode-scrim" />
                      <span className="episode-body">
                        <span className="episode-kicker">{t('details.episode')} {video.episode}</span>
                        <strong className="episode-title">{video.name || `${t('details.episode')} ${video.episode}`}</strong>
                        {video.overview ? <span className="episode-overview">{video.overview}</span> : null}
                        {detail?.runtime ? (
                          <span className="episode-foot"><Play size={11} aria-hidden="true" />{detail.runtime}</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </Carousel>
              ) : detail ? <p className="empty-copy">{t('details.noEpisodes')}</p> : null}
            </motion.div>
          ) : mode === 'viewer' ? (
            <motion.div
              key="request"
              className="details-request"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              transition={{ duration: 0.2, ease: REVEAL_EASE }}
            >
              {selected ? (
                <button type="button" className="details-back" onClick={() => setSelected(null)}>
                  <ChevronLeft size={15} aria-hidden="true" />
                  {t('details.back')} · E{selected.episode} {selected.name}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-button raised"
                disabled={requested}
                onClick={requestEpisode}
              >
                <MessageSquareShare size={16} aria-hidden="true" />
                {requested ? t('details.requested') : t('details.requestHost')}
              </button>
            </motion.div>
          ) : target ? (
            <motion.div
              key="sources"
              className="details-streams"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(8px)' }}
              transition={{ duration: 0.2, ease: REVEAL_EASE }}
            >
              {meta.type === 'series' && selected ? (
                <button type="button" className="details-back" onClick={() => setSelected(null)}>
                  <ChevronLeft size={15} aria-hidden="true" />
                  {t('details.back')} · E{selected.episode} {selected.name}
                </button>
              ) : null}
              <div className="details-streams-head">
                <h3>{t('details.sources')}</h3>
                {streams && streams.length > 0 ? (
                  <div className="stream-filters">
                    <Dropdown
                      label={t('details.quality')}
                      value={resolutionFilter}
                      options={[
                        { value: 'all', label: t('details.allQualities'), detail: `(${streams.length})` },
                        ...resolutionOptions.map((value) => ({
                          value,
                          label: value === 'sd' ? 'SD' : value,
                          detail: `(${streams.filter((stream) => stream.resolution === value).length})`,
                        })),
                      ]}
                      onChange={(value) => setResolutionFilter(value as 'all' | StreamResolution)}
                      align="end"
                    />
                    {languageOptions.length > 0 ? (
                      <Dropdown
                        label={t('details.language')}
                        value={languageFilter}
                        options={[
                          { value: 'all', label: t('details.allLanguages'), detail: `(${streams.length})` },
                          ...languageOptions.map((flag) => ({
                            value: flag,
                            label: `${flag} ${languageName(flag, t.language)}`,
                            detail: `(${streams.filter((stream) => stream.languages.includes(flag)).length})`,
                          })),
                        ]}
                        onChange={setLanguageFilter}
                        align="end"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
              {streams === null && !streamsFailed ? (
                <motion.div
                  key={`skeleton:${target.season ?? 0}:${target.episode ?? 0}`}
                  className="stream-list"
                  aria-label={t('details.loadingSources')}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  transition={{ duration: 0.25, ease: REVEAL_EASE }}
                >
                  {Array.from({ length: 5 }, (_, index) => <span key={index} className="stream-skeleton" />)}
                </motion.div>
              ) : streamsFailed || streams === null ? (
                <SourcesEmpty
                  icon={<PlugZap size={20} aria-hidden="true" />}
                  title={t('details.sourcesFailed')}
                  hint={t('details.pluginsBrokeHint')}
                  action={{ label: t('details.retrySources'), onClick: () => setStreamRetry((seq) => seq + 1) }}
                />
              ) : noPlugins ? (
                // Quatro estados, porque são quatro problemas diferentes: nada
                // instalado, instalado e não achou, instalado e quebrou, e
                // achou mas os filtros escondem. Cada um leva a uma saída
                // distinta, e é a saída que justifica separá-los.
                <SourcesEmpty
                  icon={<Puzzle size={20} aria-hidden="true" />}
                  title={t('details.noPlugins')}
                  hint={t('details.noPluginsHint')}
                  action={{ label: t('details.openPlugins'), onClick: () => onOpenPlugins?.(), primary: true }}
                />
              ) : streams.length === 0 && brokenPlugins.length > 0 ? (
                // Tudo que rodou, quebrou. Mandar instalar mais plugins aqui
                // seria conselho para outro problema.
                <SourcesEmpty
                  icon={<PlugZap size={20} aria-hidden="true" />}
                  title={`${t('details.pluginsBroke')} ${brokenPlugins.join(', ')}`}
                  hint={t('details.pluginsBrokeHint')}
                  action={{ label: t('details.retrySources'), onClick: () => setStreamRetry((seq) => seq + 1) }}
                />
              ) : streams.length === 0 ? (
                <SourcesEmpty
                  icon={<SearchX size={20} aria-hidden="true" />}
                  title={t('details.noPluginResolved')}
                  hint={t('details.noPluginResolvedHint')}
                  action={{ label: t('details.openPlugins'), onClick: () => onOpenPlugins?.() }}
                />
              ) : visibleStreams.length === 0 ? (
                <SourcesEmpty
                  icon={<Filter size={20} aria-hidden="true" />}
                  title={t('details.noFilteredSources')}
                  hint={t('details.noFilteredSourcesHint')}
                  action={{
                    label: t('details.clearFilters'),
                    onClick: () => { setResolutionFilter('all'); setLanguageFilter('all') },
                    primary: true,
                  }}
                />
              ) : (
                <motion.div
                  key={`streams:${target.season ?? 0}:${target.episode ?? 0}`}
                  className="stream-list"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  transition={{ duration: 0.25, ease: REVEAL_EASE }}
                >
                  {visibleStreams.slice(0, 30).map((stream) => (
                    <button
                      key={streamKey(stream)}
                      type="button"
                      // A url source has nowhere to go until the server-side
                      // ingest exists. Offering it and throwing on click is
                      // worse than saying so.
                      disabled={!isPlayable(stream)}
                      title={isPlayable(stream) ? undefined : t('details.sourceNotSupported')}
                      onClick={() => onPickStream({
                        stream,
                        target,
                        displayName: selected
                          ? `${meta.name} S${String(selected.season).padStart(2, '0')}E${String(selected.episode).padStart(2, '0')}`
                          : meta.name,
                        metaName: detail?.name ?? meta.name,
                        poster: detail?.poster || meta.poster,
                      })}
                    >
                      <span className="stream-label">{stream.label}</span>
                      <span className="stream-meta">
                        <span className="stream-quality">{stream.quality}</span>
                        {stream.languages.length > 0 ? <span className="stream-langs">{stream.languages.slice(0, 6).join(' ')}</span> : null}
                        {stream.seeders !== null ? <span>{stream.seeders} seeds</span> : null}
                        {stream.size ? <span>{stream.size}</span> : null}
                        {stream.source ? <span className="stream-source">{stream.source}</span> : null}
                      </span>
                    </button>
                  ))}
                </motion.div>
              )}
            </motion.div>
          ) : null}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  )
}
