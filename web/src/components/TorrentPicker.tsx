import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile, type WorkerProbe } from '../torrent'
import { torrentCapacity } from '../remoteTorrent'
import { torrentErrorKey } from '../torrentErrors'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

/** How often the file list re-reads the swarm's counters. */
const STATS_INTERVAL_MS = 500

interface TorrentPickerProps {
  maxFileBytes: number
  /** Handed a selected and prioritized file, and the magnet it came from; ownership of the session moves to the caller. */
  onPicked: (file: TorrentVideoFile, session: TorrentSession, magnet: string) => void
  /** Called when backing out past the magnet, to leave the torrent flow. */
  onExit?: () => void
  /** A swarm given back by the caller, so the picker opens on its list rather than on an empty magnet. */
  initialSession?: TorrentSession | null
  /** The magnet that swarm was listed from, so backing out of the list still has it. */
  initialMagnet?: string
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
 * It owns the session until a file is picked, and tears down what it opened on
 * unmount, so abandoning the dialog never leaves a swarm connection running. A
 * session handed in by the caller is a step being resumed rather than one
 * opened here: it is given up only deliberately, by backing out of its list.
 */
export function TorrentPicker({ maxFileBytes, onPicked, onExit, initialSession, initialMagnet = '', t }: TorrentPickerProps) {
  const [magnet, setMagnet] = useState(initialMagnet)
  const [loading, setLoading] = useState(false)
  // The fleet as this browser measured it, shown while it happens: which
  // workers answered, how fast each one is from here, and which one won.
  const [probes, setProbes] = useState<WorkerProbe[]>([])
  // Whether the fleet can take a magnet at all right now. Asked once when the
  // picker opens: metadata needs a worker, so the answer belongs at the paste,
  // not at play.
  const [capacity, setCapacity] = useState<string>('available')
  useEffect(() => {
    let cancelled = false
    void torrentCapacity().then((value) => {
      if (cancelled) return
      setCapacity(value)
      if (value === 'disabled' || value === 'no_workers') setError(t('home.torrentNoWorkers'))
      else if (value === 'busy') setError(t('home.torrentBusy'))
    })
    return () => { cancelled = true }
  }, [t])
  const [error, setError] = useState('')
  const [session, setSession] = useState<TorrentSession | null>(initialSession ?? null)
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
  //
  // It is the session itself that is held a beat behind, not merely whether
  // there is one. Backing out hands the swarm back at once, and a list drawn
  // from the live session would empty on that frame — while it is still fully
  // on screen — collapsing the panel to the height of its own heading and then
  // sending it back up once the magnet field arrived. Drawn from the outgoing
  // session it dissolves at the size it had, and the panel travels once.
  const { shown: listed, morphing: picking } = useMorphingStep(session)
  const listing = listed !== null

  const needle = query.trim().toLowerCase()
  const matches = !listed ? [] : needle === ''
    ? listed.files
    : listed.files.filter((file) => file.name.toLowerCase().includes(needle))

  useEffect(() => () => owned.current?.destroy(), [])

  // A swarm reports its progress to whoever opened it. One handed back to a
  // picker that did not open it would report to a picker that no longer
  // exists, so a list on screen reads the numbers off the session instead of
  // waiting to be told them.
  useEffect(() => {
    if (!session) return
    setStats(session.stats())
    const timer = window.setInterval(() => setStats(session.stats()), STATS_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [session])

  const load = async () => {
    if (!magnet.trim() || loading) return
    if (capacity === 'disabled' || capacity === 'no_workers') {
      setError(t('home.torrentNoWorkers'))
      return
    }
    session?.destroy()
    owned.current = null
    setSession(null)
    setError('')
    setStats(EMPTY_TORRENT_STATS)
    setProbes([])
    setLoading(true)
    try {
      const opened = await openTorrent(magnet, setStats, { onProbe: setProbes })
      owned.current = opened
      setSession(opened)
      if (opened.files.length === 0) setError(t('home.torrentNoVideos'))
    } catch (error) {
      // A fleet that is missing or full is not a bad magnet, and "check the
      // magnet" would send someone to fix the wrong thing.
      setError(t(torrentErrorKey(error)))
    } finally {
      setLoading(false)
    }
  }

  // Retreats one step. From the list that is the magnet it was listed from,
  // still holding what was typed — a swarm with the wrong episode in it should
  // not cost the magnet as well. From the magnet there is nothing left to
  // retreat to, so it leaves. Which of the two it is comes from the live
  // session, not from the step being drawn: what a press does is decided by
  // where the picker actually is, not by what is still fading out of it.
  const back = () => {
    if (!session) { onExit?.(); return }
    session.destroy()
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
    onPicked(file, session, magnet)
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
      ) : listed ? (
        <>
          <div className="torrent-summary">
            <strong>{listed.name}</strong>
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
      {probes.length > 0 ? (
        <div className="worker-probes" aria-live="polite">
          <span className="worker-probes-title">
            {probes.some((p) => p.state === 'testing') ? t('home.workersTesting') : t('home.workersTested')}
          </span>
          {probes.map((probe) => (
            <span key={probe.id} className={`worker-probe ${probe.chosen ? 'is-chosen' : ''} ${probe.state === 'down' ? 'is-down' : ''}`}>
              <code>{probe.id.replace(/^w_/, '').slice(0, 6)}</code>
              {probe.state === 'testing' ? t('home.workerTesting')
                : probe.state === 'down' ? t('home.workerOffline')
                  : `${probe.mbit} Mbit/s${probe.ttfbMs !== undefined ? ` · ${probe.ttfbMs}ms` : ''}`}
              {probe.holds ? <em>{t('home.workerHolds')}</em> : null}
              {probe.chosen ? <strong>{t('home.workerChosen')}</strong> : null}
            </span>
          ))}
        </div>
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
