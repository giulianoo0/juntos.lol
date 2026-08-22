import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { clearToken, createPin, getToken, pollPin, setToken } from './account'
import { itemDetails, searchLibrary, type PlexItem } from './library'
import { listServers, pickConnection, type PlexConnection } from './server'
import { openPlexItem, type PlexOpen } from './open'

type Found = Pick<PlexItem, 'ratingKey' | 'title' | 'year' | 'type'>

/** How often the pin is asked about while the person approves it. */
const POLL_MS = 2_000
const SEARCH_DEBOUNCE_MS = 300

/**
 * Plex, as a source the host connects once rather than as a plugin.
 *
 * It is a section of its own inside the plugins panel, above the list and
 * visibly apart. It is not a plugin — it needs a pairing flow, a stored
 * account credential and server discovery, none of which the plugin contract
 * has or should have — and listing it among them would teach the wrong thing
 * to whoever comes to write one.
 */
export function PlexSection({ onPlay }: { onPlay: (open: PlexOpen) => void }) {
  const t = useT()
  const [token, setStoredToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [pin, setPin] = useState<{ id: number; code: string; authUrl: string } | null>(null)
  const [serverName, setServerName] = useState<string | null>(null)
  const [connection, setConnection] = useState<PlexConnection | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Found[]>([])
  const [error, setError] = useState<string | null>(null)
  const searchSeq = useRef(0)

  useEffect(() => {
    void getToken().then((stored) => { setStoredToken(stored); setReady(true) })
  }, [])

  // The pin poll has to stop. A pin expires in minutes and pollPin throws when
  // it does; without this the interval outlives the panel and keeps hitting
  // plex.tv for ever.
  useEffect(() => {
    if (!pin) return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const fresh = await pollPin(pin.id)
          if (fresh && !stopped) {
            await setToken(fresh)
            setStoredToken(fresh)
            setPin(null)
          }
        } catch (cause) {
          if (stopped) return
          setPin(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })()
    }, POLL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [pin])

  // Once there is a token: find the servers, then race every way of reaching
  // the first one and keep whichever answers.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const [server] = await listServers(token)
        if (!server || cancelled) {
          if (!cancelled) setError(t('plex.unreachable'))
          return
        }
        const chosen = await pickConnection(server, token)
        if (cancelled) return
        setServerName(server.name)
        setConnection(chosen)
      } catch {
        if (!cancelled) setError(t('plex.unreachable'))
      }
    })()
    return () => { cancelled = true }
  }, [token, t])

  useEffect(() => {
    const trimmed = query.trim()
    if (!connection || !token || trimmed === '') {
      setResults([])
      return
    }
    const seq = (searchSeq.current += 1)
    const timer = window.setTimeout(() => {
      void searchLibrary(connection.uri, token, trimmed)
        .then((found) => { if (searchSeq.current === seq) setResults(found) })
        .catch(() => { if (searchSeq.current === seq) setResults([]) })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, connection, token])

  const connect = useCallback(async () => {
    setError(null)
    try {
      setPin(await createPin())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const disconnect = useCallback(async () => {
    await clearToken()
    setStoredToken(null)
    setServerName(null)
    setConnection(null)
    setResults([])
    setQuery('')
  }, [])

  const play = useCallback(async (found: Found) => {
    if (!connection || !token) return
    setError(null)
    try {
      onPlay(openPlexItem(connection, await itemDetails(connection.uri, token, found.ratingKey), token))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [connection, token, onPlay])

  if (!ready) return null

  return (
    <section className="plex-section" aria-label={t('plex.title')}>
      <h3>{t('plex.title')}</h3>

      {!token ? (
        pin ? (
          <>
            <p className="empty-copy">{t('plex.code')}</p>
            <code className="plex-code">{pin.code}</code>
            {/* Opening the approval page is the person's move, not ours: a
                popup opened from an effect is blocked by every browser. */}
            <a className="primary-button raised" href={pin.authUrl} target="_blank" rel="noopener noreferrer">
              {t('plex.approve')}
            </a>
          </>
        ) : (
          <button type="button" className="primary-button" onClick={() => void connect()}>
            {t('plex.connect')}
          </button>
        )
      ) : !connection ? (
        <p className="empty-copy">{error ?? t('plex.finding')}</p>
      ) : (
        <>
          <div className="plex-server">
            <span className="plugins-name">{serverName}</span>
            <button type="button" onClick={() => void disconnect()}>{t('plex.disconnect')}</button>
          </div>
          {/* Which kind of connection won matters to the person: on a LAN one
              the transfer needs this tab to stay open, and on a public one it
              does not. */}
          <p className="empty-copy plex-route">
            {t(connection.local || connection.relay ? 'plex.viaLan' : 'plex.viaInternet')}
          </p>
          <label className="plugins-url">
            <span>{t('plex.search')}</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {results.length > 0 ? (
            <ul className="plugins-list plex-results">
              {results.map((found) => (
                <li key={found.ratingKey}>
                  <button type="button" className="plex-result" onClick={() => void play(found)}>
                    {found.title}{found.year ? ` (${found.year})` : ''}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {error && connection ? <p className="empty-copy">{error}</p> : null}
    </section>
  )
}
