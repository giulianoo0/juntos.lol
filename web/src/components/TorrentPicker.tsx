import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { openTorrent, type TorrentSession, type TorrentStats, type TorrentVideoFile } from '../torrent'

const EMPTY_TORRENT_STATS: TorrentStats = { peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }

interface TorrentPickerProps {
  maxFileBytes: number
  /** Handed a selected and prioritized file; ownership of the session moves to the caller. */
  onPicked: (file: TorrentVideoFile, session: TorrentSession) => void
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
export function TorrentPicker({ maxFileBytes, onPicked, t }: TorrentPickerProps) {
  const [magnet, setMagnet] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState<TorrentSession | null>(null)
  const [stats, setStats] = useState<TorrentStats>(EMPTY_TORRENT_STATS)
  const owned = useRef<TorrentSession | null>(null)

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
    <>
      <h2 id="torrent-dialog-title">{session ? t('home.torrentChooseFile') : t('home.torrentTitle')}</h2>
      <p>{session ? t('home.torrentChooseGuide') : t('home.torrentGuide')}</p>
      {!session ? (
        <>
          <label htmlFor="magnet-link">{t('home.magnet')}</label>
          <textarea
            id="magnet-link"
            className="sunken magnet-input"
            autoFocus
            rows={4}
            value={magnet}
            placeholder="magnet:?xt=urn:btih:…"
            onChange={(event) => setMagnet(event.target.value)}
          />
          {loading ? <div className="torrent-loading"><span className="torrent-spinner" aria-hidden="true" />{t('home.torrentMetadata')}</div> : null}
        </>
      ) : (
        <>
          <div className="torrent-summary">
            <strong>{session.name}</strong>
            <span>{stats.peers} {t('home.peers')} · {formatBytes(stats.downloadSpeed)}/s</span>
          </div>
          <div className="torrent-files">
            {session.files.map((file) => (
              <button type="button" key={file.path} onClick={() => { void pick(file) }}>
                <span>{file.name}</span><small>{formatBytes(file.size)}</small>
              </button>
            ))}
          </div>
        </>
      )}
      {error ? <div className="error-card torrent-error" role="alert">{error}</div> : null}
      {!session ? (
        <button type="button" className="primary-button torrent-load" disabled={loading || !magnet.trim()} onClick={() => { void load() }}>
          {t('home.torrentLoad')}
        </button>
      ) : null}
    </>
  )
}
