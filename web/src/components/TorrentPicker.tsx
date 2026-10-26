import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { openTorrent, torrentCapacity, type TorrentSession, type TorrentStats, type TorrentVideoFile, type WorkerProbe } from '../torrent'
import { WorkerProbes } from './WorkerProbes'
import { torrentErrorKey } from '../torrentErrors'
import { Film, Magnet, Play } from 'lucide-react'
import { Field } from '../ui/Field'
import { Pill } from '../ui/Pill'
import styles from './Picker.module.css'
import { isYoutubeLink } from '../youtube'

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

const STATS_INTERVAL_MS = 500

interface TorrentPickerProps {
  maxFileBytes: number
  onPicked: (file: TorrentVideoFile, session: TorrentSession, magnet: string) => void
  onExit?: () => void
  /** A YouTube link pasted where a magnet goes is handed here instead of refused. */
  onYoutubeLink?: (url: string) => void
  initialSession?: TorrentSession | null
  initialMagnet?: string
  /** Lists the initial magnet on mount, so the room's own torrent opens as
   * a playlist instead of asking for the link again. */
  autoLoad?: boolean
  /** The file playing now, marked in the list. */
  currentPath?: string
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
export function TorrentPicker({ maxFileBytes, onPicked, onExit, onYoutubeLink, initialSession, initialMagnet = '', autoLoad = false, currentPath, t }: TorrentPickerProps) {
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
  const owned = useRef<TorrentSession | null>(null)
  const listed = session
  const listing = listed !== null

  const needle = query.trim().toLowerCase()
  const matches = !listed ? [] : needle === ''
    ? listed.files
    : listed.files.filter((file) => file.name.toLowerCase().includes(needle))

  useEffect(() => () => owned.current?.destroy(), [])

  useEffect(() => {
    if (!session) return
    setStats(session.stats())
    const timer = window.setInterval(() => setStats(session.stats()), STATS_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [session])

  const youtubeLink = onYoutubeLink !== undefined && isYoutubeLink(magnet)

  const load = async () => {
    if (!magnet.trim() || loading) return
    if (youtubeLink) {
      onYoutubeLink?.(magnet.trim())
      return
    }
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
      setError(t(torrentErrorKey(error)))
    } finally {
      setLoading(false)
    }
  }

  const autoLoaded = useRef(false)
  useEffect(() => {
    if (!autoLoad || autoLoaded.current || !initialMagnet.trim()) return
    autoLoaded.current = true
    void load()
    // Only the first mount lists the magnet; later changes are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, initialMagnet])

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
    owned.current = null
    setSession(null)
    onPicked(file, session, magnet)
  }

  return (
    <div className={styles.flow}>
      {!listing ? (
        <form className={styles.ask} onSubmit={(event) => { event.preventDefault(); void load() }}>
          <Field
            mono
            aria-label={t('home.magnet')}
            autoFocus
            value={magnet}
            disabled={loading}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="magnet:?xt=urn:btih:…"
            onChange={(event) => setMagnet(event.target.value)}
          />
          <Pill type="submit" tone="primary" size="lg" disabled={loading || !magnet.trim()} aria-busy={loading}>
            {t(loading ? 'home.torrentLoading' : youtubeLink ? 'home.openYoutube' : 'home.torrentLoad')}
          </Pill>
        </form>
      ) : (
        <>
          <Field
            aria-label={t('home.torrentSearch')}
            autoFocus
            value={query}
            placeholder={t('home.torrentSearch')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {matches.length > 0 ? (
            <div className={styles.list}>
              {matches.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  className={styles.row}
                  aria-current={file.path === currentPath ? 'true' : undefined}
                  onClick={() => { void pick(file) }}
                >
                  <span className={styles.rowIcon} aria-hidden="true">{file.path === currentPath ? <Play size={15} /> : <Film size={15} />}</span>
                  <span className={styles.rowName} title={file.name}>{file.name}</span>
                  <span className={styles.rowMeta}>{formatBytes(file.size)}</span>
                </button>
              ))}
            </div>
          ) : <p className={styles.empty}>{t('home.torrentNoMatch')}</p>}
        </>
      )}
      <WorkerProbes probes={probes} t={t} />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {listing ? (
        <div className={styles.foot}>
          <Pill tone="soft" size="sm" icon={<Magnet size={14} />} onClick={back}>{t('home.torrentSwitchMagnet')}</Pill>
          <span className={styles.readout}>{stats.peers} {t('home.peers')} · {formatBytes(stats.downloadSpeed)}/s</span>
        </div>
      ) : null}
    </div>
  )
}
