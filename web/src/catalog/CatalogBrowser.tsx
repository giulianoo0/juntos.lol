import { memo, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Search, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { fetchCatalog, searchCatalog, type CatalogMeta, type MetaType } from './cinemeta'
import { PosterCard, type TitleOpen } from './PosterCard'
import { Carousel } from './Carousel'
import { prefetchMetaDetails } from './lazyDetails'

const SEARCH_DEBOUNCE_MS = 300

interface RowSpec {
  key: string
  labelKey: string
  type: MetaType
  genre?: string
}

// The board is a fixed set of Cinemeta "top" catalogs; rows render as each
// one arrives instead of waiting for the slowest.
const ROWS: RowSpec[] = [
  { key: 'movies', labelKey: 'catalog.popularMovies', type: 'movie' },
  { key: 'series', labelKey: 'catalog.popularSeries', type: 'series' },
  { key: 'action', labelKey: 'catalog.action', type: 'movie', genre: 'Action' },
  { key: 'comedy', labelKey: 'catalog.comedy', type: 'series', genre: 'Comedy' },
  { key: 'animation', labelKey: 'catalog.animation', type: 'series', genre: 'Animation' },
]

type RowState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; metas: CatalogMeta[] }

interface CatalogBrowserProps {
  onOpenTitle: (open: TitleOpen) => void
  // The room overlay renders the browser inside a smaller frame; rows shrink
  // a little so a full row still fits.
  compact?: boolean
  // While the details panel is up the floating search hides; it only comes
  // back once the close morph has finished (the parent flips this after).
  hideSearch?: boolean
}

// The searchable board: a search field over rows of posters. Selecting a
// title is the parent's business — the browser only reports the pick.
//
// Memoised: the pages that host it re-render for reasons that are not the
// board's — every keystroke in the nickname dialog, every upload progress
// tick, every player state change in a room — and each one used to walk two
// hundred poster cards and five carousels again. The props are a stable
// callback and two flags, so the memo holds.
export const CatalogBrowser = memo(function CatalogBrowser({ onOpenTitle, compact, hideSearch }: CatalogBrowserProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [retrySeq, setRetrySeq] = useState(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogMeta[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchSeqRef = useRef(0)
  // The floating search: an expanded pill by default on desktop, compressing
  // into a round icon button while scrolling down. On mobile it starts as the
  // round button and is driven by focus and content, never by scroll.
  const [searchCompact, setSearchCompact] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusedRef = useRef(false)
  // Read inside the scroll listener, which is bound once.
  const queryRef = useRef('')

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches

  // On mobile the expanded search covers the row that holds the view tabs, so
  // the tabs step aside while it is open (see the CSS). Harmless on desktop,
  // where that rule does not apply.
  useEffect(() => {
    document.body.classList.toggle('catalog-search-open', !searchCompact)
    return () => document.body.classList.remove('catalog-search-open')
  }, [searchCompact])

  // The details panel is loaded on demand, and every route to it starts on
  // this board. Warming it once the browser is idle keeps it off the first
  // paint without ever making a click on a poster wait for the network.
  useEffect(() => {
    const idle = window.requestIdleCallback
    if (typeof idle === 'function') {
      const handle = idle(prefetchMetaDetails, { timeout: 4_000 })
      return () => window.cancelIdleCallback?.(handle)
    }
    const timer = window.setTimeout(prefetchMetaDetails, 2_000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    // The board scrolls on the page at home and on the overlay's own body in
    // a room; listen to whichever scrollable ancestor this instance lives in.
    let target: HTMLElement | Window = window
    for (let node = rootRef.current?.parentElement; node; node = node.parentElement) {
      const overflow = window.getComputedStyle(node).overflowY
      if (overflow === 'auto' || overflow === 'scroll') {
        target = node
        break
      }
    }
    // Built once: matchMedia parses the query and allocates a list object,
    // and this runs on every scroll tick.
    const mobileQuery = window.matchMedia('(max-width: 620px)')
    let lastY = target instanceof Window ? target.scrollY : target.scrollTop
    const onScroll = () => {
      const y = target instanceof Window ? target.scrollY : target.scrollTop
      const delta = y - lastY
      lastY = y
      // Mobile drives the search by focus and content, not scroll.
      if (mobileQuery.matches) return
      // A field being typed in, or already holding a query, never collapses
      // out from under the cursor — scrolling the results is part of using it.
      if (focusedRef.current || queryRef.current.trim() !== '') return
      if (delta > 4 && y > 40) setSearchCompact(true)
      else if (delta < -4 || y <= 40) setSearchCompact(false)
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [])

  const expandSearch = () => {
    setSearchCompact(false)
    // Focus once the input exists again, after this render commits.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  useEffect(() => {
    let cancelled = false
    setRows((current) => {
      const next = { ...current }
      for (const row of ROWS) {
        if (next[row.key]?.status !== 'ready') next[row.key] = { status: 'loading' }
      }
      return next
    })
    for (const row of ROWS) {
      fetchCatalog(row.type, row.genre)
        .then((metas) => {
          if (!cancelled) setRows((current) => ({ ...current, [row.key]: { status: 'ready', metas: metas.slice(0, 40) } }))
        })
        .catch(() => {
          if (!cancelled) setRows((current) => (
            current[row.key]?.status === 'ready' ? current : { ...current, [row.key]: { status: 'error' } }
          ))
        })
    }
    return () => { cancelled = true }
  }, [retrySeq])

  useEffect(() => {
    queryRef.current = query
    const seq = (searchSeqRef.current += 1)
    const trimmed = query.trim()
    if (!trimmed) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      searchCatalog(trimmed)
        .then((metas) => {
          if (searchSeqRef.current !== seq) return
          setResults(metas)
          setSearching(false)
        })
        .catch(() => {
          if (searchSeqRef.current !== seq) return
          setResults([])
          setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const typing = query.trim() !== ''

  const enter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, transform: 'translateY(10px)' }, animate: { opacity: 1, transform: 'translateY(0px)' } }

  return (
    <div ref={rootRef} className={`catalog-browser ${compact ? 'is-compact' : ''}`}>
      <motion.div
        layout={!reduceMotion}
        className={`catalog-search ${searchCompact ? 'is-collapsed' : ''}`}
        style={{ borderRadius: 999 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: hideSearch ? 0 : 1 }}
        transition={reduceMotion ? { duration: 0.15 } : { type: 'spring', duration: 0.55, bounce: 0.25, opacity: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
        data-hidden={hideSearch ? 'true' : undefined}
        onClick={searchCompact ? expandSearch : undefined}
        role={searchCompact ? 'button' : undefined}
        aria-label={searchCompact ? t('catalog.search') : undefined}
        // The input this replaced was focusable; its stand-in must be too,
        // or scrolling the board locks keyboard users out of search.
        tabIndex={searchCompact ? 0 : undefined}
        onKeyDown={searchCompact ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            expandSearch()
          }
        } : undefined}
      >
        {/* A layout child of a layout parent gets counter-scaled while the
            pill travels, so the glyph glides instead of stretching with it. */}
        <motion.span layout={!reduceMotion} className="catalog-search-icon" aria-hidden="true">
          <Search size={17} />
        </motion.span>
        {/* popLayout lifts the leaving field out of the pill's layout, so the
            shell starts shrinking at once and the text only fades — instead of
            being squeezed along for the ride. */}
        <AnimatePresence mode="popLayout" initial={false}>
          {!searchCompact ? (
            <motion.div
              key="field"
              className="catalog-search-field"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
            >
              <input
                ref={inputRef}
                type="search"
                value={query}
                placeholder={t('catalog.searchPlaceholder')}
                aria-label={t('catalog.search')}
                onFocus={() => { focusedRef.current = true }}
                onBlur={() => {
                  focusedRef.current = false
                  // On mobile an empty field folds back to the button on blur;
                  // one with a query stays open.
                  if (isMobile() && queryRef.current.trim() === '') setSearchCompact(true)
                }}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button type="button" className="catalog-search-clear" aria-label={t('catalog.clearSearch')} onClick={() => setQuery('')}>
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>

      {/* The first keystroke swaps the board for the shape of an answer:
          waiting on the debounce and the request with the rows still up reads
          as the search having done nothing. */}
      {typing && results === null ? (
        ['catalog.movies', 'catalog.series'].map((labelKey) => (
          <section key={labelKey} className="catalog-row" aria-hidden="true">
            <h2>{t(labelKey)}</h2>
            <div className="catalog-strip">
              {Array.from({ length: 8 }, (_, index) => <span key={index} className="poster-skeleton" />)}
            </div>
          </section>
        ))
      ) : results !== null ? (
        results.length > 0 ? (
          // Results keep the board's own shape: one Filmes row, one Séries
          // row, each on the same carousel as everywhere else.
          [
            { key: 'movie' as const, labelKey: 'catalog.movies' },
            { key: 'series' as const, labelKey: 'catalog.series' },
          ].map(({ key, labelKey }) => {
            const metas = results.filter((meta) => meta.type === key)
            if (metas.length === 0) return null
            return (
              <motion.section
                key={key}
                className="catalog-row"
                aria-label={t(labelKey)}
                {...enter}
                transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
              >
                <h2>{t(labelKey)}</h2>
                <Carousel prevLabel={t('catalog.scrollBack')} nextLabel={t('catalog.scrollForward')}>
                  {metas.map((meta) => (
                    <PosterCard key={`${meta.type}:${meta.id}`} meta={meta} onOpen={onOpenTitle} />
                  ))}
                </Carousel>
              </motion.section>
            )
          })
        ) : (
          <p className="empty-copy catalog-empty">{searching ? t('catalog.searching') : t('catalog.noResults')}</p>
        )
      ) : (
        ROWS.map((row) => {
          const state = rows[row.key] ?? { status: 'loading' as const }
          return (
            <section key={row.key} className="catalog-row" aria-label={t(row.labelKey)}>
              <h2>{t(row.labelKey)}</h2>
              {state.status === 'ready' ? (
                <motion.div
                  {...enter}
                  transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
                >
                  <Carousel prevLabel={t('catalog.scrollBack')} nextLabel={t('catalog.scrollForward')}>
                    {state.metas.map((meta) => (
                      <PosterCard key={`${meta.type}:${meta.id}`} meta={meta} onOpen={onOpenTitle} />
                    ))}
                  </Carousel>
                </motion.div>
              ) : state.status === 'error' ? (
                <p className="empty-copy catalog-empty">
                  {t('catalog.rowFailed')}{' '}
                  <button type="button" className="catalog-retry" onClick={() => setRetrySeq((seq) => seq + 1)}>
                    {t('catalog.retry')}
                  </button>
                </p>
              ) : (
                <div className="catalog-strip" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, index) => <span key={index} className="poster-skeleton" />)}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
})
