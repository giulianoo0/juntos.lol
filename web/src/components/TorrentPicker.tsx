import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile } from '../torrent'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

interface TorrentPickerProps {
  maxFileBytes: number
  /** Handed a selected and prioritized file; ownership of the session moves to the caller. */
  onPicked: (file: TorrentVideoFile, session: TorrentSession) => void
  /** Called when backing out past the magnet, to leave the torrent flow. */
  onExit?: () => void
  t: Translator
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

/**
 * Magnet input and file chooser for a torrent.
 *
 * It owns the session until a file is picked, and tears it down on unmount, so
 * abandoning the dialog never leaves a swarm connection running.
 */
export function TorrentPicker({ maxFileBytes, onPicked, onExit, t }: TorrentPickerProps) {
  const [magnet, setMagnet] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState<TorrentSession | null>(null)
  const [stats, setStats] = useState<TorrentStats>(EMPTY_TORRENT_STATS)
  const [query, setQuery] = useState('')
  const owned = useRef<TorrentSession | null>(null)
  const loadRef = useRef<HTMLButtonElement>(null)
  // The word changes a beat after the press, so the outgoing one is gone
  // before the button starts widening for the incoming one. Keyed on the shown
  // label rather than on `loading`, or the width would travel while the button
  // still reads as the old word. The shimmer and the disabling stay on
  // `loading` itself: a press has to be answered at once.
  const { shown: waiting, morphing: swapping } = useMorphingStep(loading)
  useMorphingSize(loadRef, waiting, { axis: 'width', durationMs: 260 })
  // The magnet field giving way to the file list is a step change like any
  // other, so it dissolves rather than cutting — inside the same panel, which
  // grows to fit whichever of the two is showing.
  const { shown: listing, morphing: picking } = useMorphingStep(session !== null)

  const needle = query.trim().toLowerCase()
  const matches = !session ? [] : needle === ''
    ? session.files
    : session.files.filter((file) => file.name.toLowerCase().includes(needle))

  useEffect(() => () => owned.current?.destroy(), [])

  const load = async () => {
    if (!magnet.trim() || loading) return
    owned.current?.destroy()
    owned.current = null
    setSession(null)
    setError('')
    setStats(EMPTY_TORRENT_STATS)
    setLoading(true)
    try {
      const opened = await openTorrent(magnet, setStats)
      owned.current = opened
      setSession(opened)
      if (opened.files.length === 0) setError(t('home.torrentNoVideos'))
    } catch {
      setError(t('home.torrentFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Retreats one step. From the list that is the magnet it was listed from,
  // still holding what was typed — a swarm with the wrong episode in it should
  // not cost the magnet as well. From the magnet there is nothing left to
  // retreat to, so it leaves.
  const back = () => {
    if (!listing) { onExit?.(); return }
    owned.current?.destroy()
    owned.current = null
    setSession(null)
    setQuery('')
    setError('')
  }

  const pick = async (file: TorrentVideoFile) => {
    if (!session) return
    if (file.size > maxFileBytes) {
      setError(t('home.tooLarge'))
      return
    }
    try {
      await session.select(file.path)
    } catch {
      setError(t('home.torrentFailed'))
      return
    }
    // The caller drives the upload from here and owns the teardown.
    owned.current = null
    setSession(null)
    onPicked(file, session)
  }

  return (
    <div className="morph-fade" data-morphing={picking}>
      <div className="morph-head">
        {/* Nothing to retreat to from the magnet unless the caller says where. */}
        {listing || onExit ? <StepBack label={t('home.back')} onClick={back} /> : null}
        <h2 className="stage-title">{listing ? t('home.torrentChooseFile') : t('home.torrentTitle')}</h2>
      </div>
      <p className="stage-description">{listing ? t('home.torrentChooseGuide') : t('home.torrentGuide')}</p>
      {!listing ? (
        <>
          <label htmlFor="magnet-link">{t('home.magnet')}</label>
          <textarea
            id="magnet-link"
            className="sunken magnet-input"
            autoFocus
            rows={4}
            value={magnet}
            disabled={loading}
            placeholder="magnet:?xt=urn:btih:…"
            onChange={(event) => setMagnet(event.target.value)}
          />
        </>
      ) : session ? (
        <>
          <div className="torrent-summary">
            <strong>{session.name}</strong>
            <span>{stats.peers} {t('home.peers')} · {formatBytes(stats.downloadSpeed)}/s</span>
          </div>
          {/* A season pack is dozens of files in a panel one pill wide.
              Scrolling for an episode whose name is already known is the
              wrong ask. */}
          <label className="sr-only" htmlFor="torrent-search">{t('home.torrentSearch')}</label>
          <input
            id="torrent-search"
            className="sunken torrent-search"
            autoFocus
            value={query}
            placeholder={t('home.torrentSearch')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {matches.length > 0 ? (
            <div className="torrent-files">
              {matches.map((file) => (
                <button type="button" key={file.path} onClick={() => { void pick(file) }}>
                  <span>{file.name}</span><small>{formatBytes(file.size)}</small>
                </button>
              ))}
            </div>
          ) : <p className="empty-copy torrent-empty">{t('home.torrentNoMatch')}</p>}
        </>
      ) : null}
      {error ? <div className="error-card torrent-error" role="alert">{error}</div> : null}
      {!listing ? (
        <div className="torrent-actions">
          {/* It keeps hugging its label; the label is just longer while the
              swarm is being asked. Both widths are the button's own content,
              which is why the travel between them has to be measured. */}
          <button
            ref={loadRef}
            type="button"
            className={`primary-button torrent-load ${loading ? 'is-loading' : ''}`}
            disabled={loading || !magnet.trim()}
            aria-busy={loading}
            onClick={() => { void load() }}
          >
            <span className="morph-fade button-label" data-morphing={swapping}>
              {t(waiting ? 'home.torrentLoading' : 'home.torrentLoad')}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
