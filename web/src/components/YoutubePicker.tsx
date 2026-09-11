import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { isYoutubeLink, openYoutube, youtubeCapacity, youtubeErrorKey, type YoutubeSession } from '../youtube'
import { useMorphingSize } from '../ui/useMorphingSize'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'
import { installJlocalTools, jlocalToolsStatus, type JlocalToolsStatus } from '../jlocal/youtube'
import { useJLocal } from '../jlocal/status'

interface YoutubePickerProps {
  onPicked: (session: YoutubeSession) => void
  onExit?: () => void
  initialUrl?: string
  t: Translator
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * Turns a pasted link into a resolved video the host confirms. The session
 * it resolved is released on unmount unless it was handed over.
 */
export function YoutubePicker({ onPicked, onExit, initialUrl = '', t }: YoutubePickerProps) {
  const [url, setUrl] = useState(initialUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState<YoutubeSession | null>(null)
  const [capacity, setCapacity] = useState<string>('available')
  const owned = useRef<YoutubeSession | null>(null)
  const loadRef = useRef<HTMLButtonElement>(null)
  const { shown: waiting, morphing: swapping } = useMorphingStep(loading)
  useMorphingSize(loadRef, waiting, { axis: 'width', durationMs: 260 })
  const { shown: resolved, morphing: picking } = useMorphingStep(session)
  const jlocal = useJLocal()
  const [tools, setTools] = useState<JlocalToolsStatus | null>(null)

  // The companion app can prepare links from this machine once it holds
  // yt-dlp and FFmpeg; while it downloads them the picker shows how far.
  useEffect(() => {
    if (!jlocal.connected) { setTools(null); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const next = await jlocalToolsStatus()
      if (cancelled) return
      setTools(next)
      if (next?.status === 'downloading') timer = setTimeout(() => { void tick() }, 1000)
    }
    void tick()
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer) }
  }, [jlocal.connected])

  const offerTools = async () => {
    const next = await installJlocalTools()
    setTools(next)
    if (next?.status === 'downloading') {
      const poll = async () => {
        const current = await jlocalToolsStatus()
        setTools(current)
        if (current?.status === 'downloading') setTimeout(() => { void poll() }, 1000)
        else if (current?.status === 'ready') { setCapacity('available'); setError('') }
      }
      setTimeout(() => { void poll() }, 1000)
    }
  }

  useEffect(() => {
    let cancelled = false
    void youtubeCapacity().then((value) => {
      if (cancelled) return
      setCapacity(value)
      if (value === 'disabled' || value === 'no_workers') setError(t('home.youtubeNoWorkers'))
      else if (value === 'busy') setError(t('home.youtubeBusy'))
    })
    return () => { cancelled = true }
  }, [t])

  useEffect(() => () => owned.current?.destroy(), [])

  const valid = isYoutubeLink(url)

  const load = async () => {
    if (!valid || loading) return
    if (capacity === 'disabled' || capacity === 'no_workers') {
      setError(t('home.youtubeNoWorkers'))
      return
    }
    owned.current?.destroy()
    owned.current = null
    setSession(null)
    setError('')
    setLoading(true)
    try {
      const opened = await openYoutube(url)
      owned.current = opened
      setSession(opened)
    } catch (error) {
      setError(t(youtubeErrorKey(error)))
    } finally {
      setLoading(false)
    }
  }

  const back = () => {
    if (!session) { onExit?.(); return }
    session.destroy()
    owned.current = null
    setSession(null)
    setError('')
  }

  const pick = () => {
    if (!session) return
    owned.current = null
    setSession(null)
    onPicked(session)
  }

  const summary = resolved?.summary ?? null
  const languages = summary ? summary.audios.map((audio) => audio.language).join(', ') : ''

  return (
    <div className="morph-fade" data-morphing={picking}>
      <div className="morph-head">
        {resolved || onExit ? <StepBack label={t('home.back')} onClick={back} /> : null}
        <h2 className="stage-title">{t('home.youtubeTitle')}</h2>
      </div>
      {!resolved ? <p className="stage-description">{t('home.youtubeGuide')}</p> : null}
      {!resolved ? (
        <>
          <input
            aria-label={t('home.youtubeLink')}
            id="youtube-link"
            className="sunken text-field youtube-input"
            autoFocus
            value={url}
            disabled={loading}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(event) => { setUrl(event.target.value); if (error && capacity === 'available') setError('') }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void load() } }}
          />
        </>
      ) : summary ? (
        <div className="youtube-summary">
          {summary.thumbnail ? <img className="youtube-thumb" src={summary.thumbnail} alt="" /> : null}
          <div className="youtube-summary-text">
            <strong>{summary.title}</strong>
            <span>
              {formatDuration(summary.durationMs)} · {summary.video.height}p {summary.video.codec}
              {resolved?.backend === 'jlocal' ? ` · ${t('home.youtubeViaJlocal')}` : ''}
            </span>
            <span>{t('home.youtubeAudios').replace('{n}', String(summary.audios.length))}{languages ? ` (${languages})` : ''}</span>
            <span>{t('home.youtubeSubtitles').replace('{n}', String(summary.subtitles.length))}</span>
          </div>
        </div>
      ) : null}
      {error ? <div className="error-card torrent-error youtube-error" role="alert">{error}</div> : null}
      {!resolved && tools && tools.status !== 'ready' && tools.status !== 'unsupported' ? (
        <div className="youtube-tools">
          {tools.status === 'downloading' ? (
            <span>{t('home.youtubeToolsDownloading').replace('{pct}', String(tools.total > 0 ? Math.min(99, Math.round((tools.done / tools.total) * 100)) : 0))}</span>
          ) : (
            <>
              {tools.status === 'failed' ? <span>{t('home.youtubeToolsFailed').replace('{error}', tools.error)}</span> : null}
              <button type="button" className="secondary-button" onClick={() => { void offerTools() }}>
                {t('home.youtubeToolsOffer')}
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="torrent-actions">
        {!resolved ? (
          <button
            ref={loadRef}
            type="button"
            className={`primary-button torrent-load ${loading ? 'is-loading' : ''}`}
            disabled={loading || !valid}
            aria-busy={loading}
            onClick={() => { void load() }}
          >
            <span className="morph-fade button-label" data-morphing={swapping}>
              {t(waiting ? 'home.youtubeLoading' : 'home.youtubeLoad')}
            </span>
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={pick}>
            {t('home.youtubeCreate')}
          </button>
        )}
      </div>
    </div>
  )
}
