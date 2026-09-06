import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile, type WorkerProbe } from '../torrent'
import {
  addMagnet,
  isJLocalTorrentAvailable,
  listJLocalTorrentFiles,
  selectJLocalFile,
  torrentStreamUrl,
  type JLocalPickedStream,
  type JLocalTorrentFile,
} from '../jlocal/torrents'
import { WorkerProbes } from './WorkerProbes'
import { torrentCapacity } from '../remoteTorrent'
import { torrentErrorKey } from '../torrentErrors'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

const STATS_INTERVAL_MS = 500

interface TorrentPickerProps {
  maxFileBytes: number
  onPicked: (file: TorrentVideoFile, session: TorrentSession, magnet: string) => void
  /** When set and the companion app advertises torrents, magnets resolve locally and picks arrive here as loopback stream URLs. */
  onPickedJLocal?: (stream: JLocalPickedStream) => void
  onExit?: () => void
  initialSession?: TorrentSession | null
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
 * Owns the swarm session until a file is picked, tearing down on unmount what
 * it opened itself; a session handed in by the caller is released only by
 * backing out of its list.
 */
export function TorrentPicker({ maxFileBytes, onPicked, onPickedJLocal, onExit, initialSession, initialMagnet = '', t }: TorrentPickerProps) {
  const [magnet, setMagnet] = useState(initialMagnet)
  const [loading, setLoading] = useState(false)
  const [probes, setProbes] = useState<WorkerProbe[]>([])
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
  const [jlocal, setJlocal] = useState<{ id: string; name: string; files: JLocalTorrentFile[] } | null>(null)
  const owned = useRef<TorrentSession | null>(null)
  const loadRef = useRef<HTMLButtonElement>(null)
  const { shown: waiting, morphing: swapping } = useMorphingStep(loading)
  useMorphingSize(loadRef, waiting, { axis: 'width', durationMs: 260 })
  const { shown: listed, morphing: picking } = useMorphingStep(session)
  const listing = listed !== null

  const needle = query.trim().toLowerCase()
  const matches = !listed ? [] : needle === ''
    ? listed.files
    : listed.files.filter((file) => file.name.toLowerCase().includes(needle))
  const jmatches = !jlocal ? [] : needle === ''
    ? jlocal.files
    : jlocal.files.filter((file) => file.name.toLowerCase().includes(needle))

  useEffect(() => () => owned.current?.destroy(), [])

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
    // The companion app serves the bytes over loopback, so the browser never
    // touches the swarm. Anything off-shape falls through to the native path
    // below, byte-identical to before.
    if (onPickedJLocal && isJLocalTorrentAvailable()) {
      const controller = new AbortController()
      try {
        const added = await addMagnet(controller.signal, magnet)
        const files = added ? await listJLocalTorrentFiles(controller.signal, added.id) : null
        if (added && files) {
          setJlocal({ id: added.id, name: added.name, files })
          if (files.length === 0) setError(t('home.torrentNoVideos'))
          setLoading(false)
          return
        }
      } catch {
        /* fall through to the native path */
      }
    }
    try {
      const opened = await openTorrent(magnet, setStats, { onProbe: setProbes })
      owned.current = opened
      setSession(opened)
      if (opened.files.length === 0) setError(t('home.torrentNoVideos'))
    } catch (error) {
      setError(t(torrentErrorKey(error)))
    } finally {
      setLoading(false)
    }
  }

  const back = () => {
    if (!session && !jlocal) { onExit?.(); return }
    session?.destroy()
    owned.current = null
    setSession(null)
    setJlocal(null)
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
    owned.current = null
    setSession(null)
    onPicked(file, session, magnet)
  }
  const pickJLocal = async (file: JLocalTorrentFile) => {
    if (!jlocal || !onPickedJLocal) return
    if (file.size > maxFileBytes) {
      setError(t('home.tooLarge'))
      return
    }
    try {
      const controller = new AbortController()
      const pinned = await selectJLocalFile(controller.signal, jlocal.id, file.index)
      if (!pinned) throw new Error('select refused')
    } catch {
      setError(t('home.torrentFailed'))
      return
    }
    const picked = {
      url: torrentStreamUrl(jlocal.id, file.index),
      name: file.name,
      size: file.size,
      torrentId: jlocal.id,
      torrentName: jlocal.name,
    }
    setJlocal(null)
    setQuery('')
    setError('')
    onPickedJLocal(picked)
  }

  return (
    <div className="morph-fade" data-morphing={picking}>
      <div className="morph-head">
        {listing || jlocal || onExit ? <StepBack label={t('home.back')} onClick={back} /> : null}
        <h2 className="stage-title">{listing || jlocal ? t('home.torrentChooseFile') : t('home.torrentTitle')}</h2>
      </div>
      <p className="stage-description">{listing || jlocal ? t('home.torrentChooseGuide') : t('home.torrentGuide')}</p>
      {!listing && !jlocal ? (
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
      ) : jlocal ? (
        <>
          <div className="torrent-summary">
            <strong>{jlocal.name}</strong>
            <span className="torrent-source-badge" title={t('jlocal.torrentLocalHint')}>{t('jlocal.torrentLocal')}</span>
          </div>
          <label className="sr-only" htmlFor="torrent-search">{t('home.torrentSearch')}</label>
          <input
            id="torrent-search"
            className="sunken torrent-search"
            autoFocus
            value={query}
            placeholder={t('home.torrentSearch')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {jmatches.length > 0 ? (
            <div className="torrent-files">
              {jmatches.map((file) => (
                <button type="button" key={file.path} onClick={() => { void pickJLocal(file) }}>
                  <span>{file.name}</span><small>{formatBytes(file.size)}</small>
                </button>
              ))}
            </div>
          ) : <p className="empty-copy torrent-empty">{t('home.torrentNoMatch')}</p>}
        </>
      ) : null}
      <WorkerProbes probes={probes} t={t} />
      {error ? <div className="error-card torrent-error" role="alert">{error}</div> : null}
      {!listing && !jlocal ? (
        <div className="torrent-actions">
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
