import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Search, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { fetchCatalog, searchCatalog, type CatalogMeta, type MetaType } from './cinemeta'
import { PosterCard, type TitleOpen } from './PosterCard'

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
}

// The searchable board: a search field over rows of posters. Selecting a
// title is the parent's business — the browser only reports the pick.
export function CatalogBrowser({ onOpenTitle, compact }: CatalogBrowserProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [retrySeq, setRetrySeq] = useState(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogMeta[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchSeqRef = useRef(0)

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

  const enter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, transform: 'translateY(10px)' }, animate: { opacity: 1, transform: 'translateY(0px)' } }

  return (
    <div className={`catalog-browser ${compact ? 'is-compact' : ''}`}>
      <div className="catalog-search sunken">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('catalog.searchPlaceholder')}
          aria-label={t('catalog.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button type="button" className="catalog-search-clear" aria-label={t('catalog.clearSearch')} onClick={() => setQuery('')}>
            <X size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {results !== null ? (
        <section aria-label={t('catalog.results')}>
          {results.length > 0 ? (
            <div className="catalog-grid">
              {results.map((meta, index) => (
                <motion.div
                  key={`${meta.type}:${meta.id}`}
                  {...enter}
                  transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: Math.min(index, 10) * 0.03 }}
                >
                  <PosterCard meta={meta} onOpen={onOpenTitle} />
                </motion.div>
              ))}
            </div>
          ) : (
            <p className="empty-copy catalog-empty">{searching ? t('catalog.searching') : t('catalog.noResults')}</p>
          )}
        </section>
      ) : (
        ROWS.map((row) => {
          const state = rows[row.key] ?? { status: 'loading' as const }
          return (
            <section key={row.key} className="catalog-row" aria-label={t(row.labelKey)}>
              <h2>{t(row.labelKey)}</h2>
              {state.status === 'ready' ? (
                <motion.div
                  className="catalog-strip"
                  {...enter}
                  transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
                >
                  {state.metas.map((meta) => (
                    <PosterCard key={`${meta.type}:${meta.id}`} meta={meta} onOpen={onOpenTitle} />
                  ))}
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
}
