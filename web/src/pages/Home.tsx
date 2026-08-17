import { useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useT } from '../i18n/useT'
import { createRoomAndUpload } from '../upload'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024

export function Home() {
  const t = useT()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [nickname, setNickname] = useState(() => localStorage.getItem('ss.nickname') ?? '')
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')

  const selectFile = async (file?: File) => {
    if (!file || progress !== null) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('home.tooLarge'))
      return
    }
    if (!nickname.trim()) {
      setError(t('home.nickname'))
      return
    }
    setError('')
    setProgress(0)
    localStorage.setItem('ss.nickname', nickname.trim())
    try {
      const roomID = await createRoomAndUpload(file, nickname.trim(), setProgress)
      navigate(`/room/${roomID}?nick=${encodeURIComponent(nickname.trim())}`)
    } catch {
      setError(t('home.failed'))
      setProgress(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void selectFile(event.dataTransfer.files[0])
  }

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    void selectFile(event.target.files?.[0])
  }

  return (
    <main className="home-shell">
      <header className="topbar">
        <a className="brand" href="/">ss</a>
        <button className="language-button" onClick={() => t.setLanguage(t.language === 'en' ? 'pt-BR' : 'en')}>
          {t.language === 'en' ? 'PT' : 'EN'}
        </button>
      </header>
      <section className="home-card raised">
        <p className="eyebrow">{t('home.eyebrow')}</p>
        <h1>{t('home.title')}</h1>
        <p className="lead">{t('home.guide')}</p>
        <label className="field-label" htmlFor="nickname">{t('home.nickname')}</label>
        <input
          id="nickname"
          className="sunken text-field"
          value={nickname}
          maxLength={64}
          onChange={(event) => setNickname(event.target.value)}
        />
        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input ref={inputRef} hidden type="file" accept="video/*,.mkv" onChange={onChange} />
          <strong>{t('home.drop')}</strong>
          <button className="primary-button raised" onClick={() => inputRef.current?.click()}>
            {t('home.choose')}
          </button>
        </div>
        {progress !== null ? (
          <div className="progress-wrap" aria-label={t('home.uploading')}>
            <div className="progress-copy"><span>{t('home.uploading')}</span><span>{progress}%</span></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
        ) : null}
        {error ? <div className="error-card" role="alert">{error}</div> : null}
      </section>
    </main>
  )
}
