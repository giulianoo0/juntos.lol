import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { isYoutubeLink, openYoutube, youtubeCapacity, youtubeErrorKey, type YoutubeSession } from '../youtube'
import { Field } from '../ui/Field'
import { Pill } from '../ui/Pill'
import { arrive } from '../ui/arrive'
import { SummarySkeleton } from './PickerSkeleton'
import styles from './Picker.module.css'
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
  const resolved = session
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
    <div className={styles.flow}>
      {!resolved ? (
        <form className={styles.ask} onSubmit={(event) => { event.preventDefault(); void load() }}>
          <Field
            aria-label={t('home.youtubeLink')}
            autoFocus
            value={url}
            disabled={loading}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="https://youtube.com/watch?v=…"
            onChange={(event) => { setUrl(event.target.value); if (error && capacity === 'available') setError('') }}
          />
          <Pill type="submit" tone="primary" size="lg" disabled={!valid} loading={loading}>
            {t('home.youtubeLoad')}
          </Pill>
        </form>
      ) : summary ? (
        <div className={`${styles.summary} ${arrive}`}>
          {summary.thumbnail ? <img className={styles.thumb} src={summary.thumbnail} alt="" /> : null}
          <div className={styles.summaryText}>
            <span className={styles.summaryTitle}>{summary.title}</span>
            <div className={styles.chips}>
              {summary.live
                ? <span className={styles.chip} data-live="">{t('home.youtubeLive')}</span>
                : <span className={styles.chip}>{formatDuration(summary.durationMs)}</span>}
              <span className={styles.chip}>{summary.video.height}p</span>
              {summary.audios.length > 1 ? <span className={styles.chip} title={languages}>{t('home.youtubeAudios').replace('{n}', String(summary.audios.length))}</span> : null}
              {!summary.live && summary.subtitles.length > 0 ? <span className={styles.chip}>{t('home.youtubeSubtitles').replace('{n}', String(summary.subtitles.length))}</span> : null}
            </div>
          </div>
        </div>
      ) : null}
      {loading ? <SummarySkeleton label={t('status.loading')} /> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {!resolved && tools && tools.status !== 'ready' && tools.status !== 'unsupported' ? (
        <div className={styles.foot}>
          {tools.status === 'downloading' ? (
            <span className={styles.readout}>{t('home.youtubeToolsDownloading').replace('{pct}', String(tools.total > 0 ? Math.min(99, Math.round((tools.done / tools.total) * 100)) : 0))}</span>
          ) : (
            <>
              {tools.status === 'failed' ? <span className={styles.readout}>{t('home.youtubeToolsFailed').replace('{error}', tools.error)}</span> : <span />}
              <Pill tone="soft" size="sm" onClick={() => { void offerTools() }}>{t('home.youtubeToolsOffer')}</Pill>
            </>
          )}
        </div>
      ) : null}
      {resolved ? (
        <div className={styles.foot}>
          <Pill tone="soft" size="md" onClick={back}>{t('drive.otherLink')}</Pill>
          <Pill tone="primary" size="md" onClick={pick}>{t('home.youtubeCreate')}</Pill>
        </div>
      ) : null}
    </div>
  )
}
