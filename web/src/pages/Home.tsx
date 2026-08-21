import { useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { MonitorUp } from 'lucide-react'
import { useT } from '../i18n/useT'
import { isScreenShareCancelled, requestScreenStream, stashScreenStream } from '../screenshare'
import { createRoomAndUpload, createRoomAndUploadTorrent, createScreenRoom, isUnreadableFile, type UploadProgress } from '../upload'
import { BuildInfo } from '../components/BuildInfo'
import { TorrentPicker } from '../components/TorrentPicker'
import { Button } from '../ui/Button'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'
import type { TorrentSession, TorrentVideoFile } from '../torrent'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024


type PendingMedia =
  | { kind: 'local'; file: File }
  | { kind: 'torrent'; file: TorrentVideoFile; session: TorrentSession }
  // The screen is granted before the room exists, so the pending pick carries
  // the live stream through the nickname step.
  | { kind: 'screen'; stream: MediaStream }

// Every source ends at the same nickname step, and every step is drawn in the
// same block, so picking a video never stacks a second surface over the one
// the user is already looking at.
type Step = 'drop' | 'torrent' | 'name' | 'starting'

export function Home() {
  const t = useT()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [nickname, setNickname] = useState(() => localStorage.getItem('ss.nickname') ?? '')
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [error, setError] = useState('')
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null)
  const [draftNickname, setDraftNickname] = useState(nickname)
  const [torrentMagnet, setTorrentMagnet] = useState('')
  const [step, setStep] = useState<Step>('drop')
  // A torrent reached the nickname step through a magnet and a list of files.
  // Backing out of the nickname undoes one step, not the whole flow, so the
  // swarm and the magnet are held here and handed back to the picker.
  const [resumed, setResumed] = useState<{ magnet: string; session: TorrentSession } | null>(null)
  const { shown, morphing } = useMorphingStep(step)
  const starting = step === 'starting'
  // The buttons flanking the panel stay mounted so their width can animate
  // away, which means they have to be withdrawn deliberately: a control
  // collapsed to nothing is still tabbable, and still announced, until it is
  // disabled and taken out of the accessibility tree.
  const aside = shown === 'drop' ? {} : { disabled: true, tabIndex: -1, 'aria-hidden': true }

  // The picker has to open inside this click, and before any room is created:
  // closing it then leaves nothing behind.
  const startScreenRoom = () => {
    void requestScreenStream().then((stream) => {
      setError('')
      setDraftNickname(nickname)
      setPendingMedia({ kind: 'screen', stream })
      setStep('name')
    }).catch((error: unknown) => {
      if (!isScreenShareCancelled(error)) setError(t('error.screenshare'))
    })
  }

  const discardPending = (media: PendingMedia | null) => {
    if (media?.kind === 'torrent') media.session.destroy()
    if (media?.kind === 'screen') media.stream.getTracks().forEach((track) => track.stop())
  }

  // One step back from the nickname. For a torrent that is the list the file
  // was picked from — the same swarm, still open, rather than a magnet to type
  // out again. For anything else there is no step in between, so it is the
  // start, and whatever was being held is given up.
  const stepBack = () => {
    const media = pendingMedia
    setPendingMedia(null)
    if (media?.kind === 'torrent') {
      setResumed({ magnet: torrentMagnet, session: media.session })
      setStep('torrent')
      return
    }
    discardPending(media)
    setStep('drop')
  }

  const selectFile = (file?: File) => {
    if (!file || starting) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('home.tooLarge'))
      return
    }
    setError('')
    setDraftNickname(nickname)
    setPendingMedia({ kind: 'local', file })
    setStep('name')
  }

  const startUpload = async () => {
    const media = pendingMedia
    if (!media || starting) return
    setPendingMedia(null)
    setStep('starting')
    try {
      // Resolves once the room exists and the upload has started; MP4s are
      // converted to MKV first, which is what the preparing state covers.
      const room = media.kind === 'local'
        ? await createRoomAndUpload(media.file, draftNickname.trim(), setProgress)
        : media.kind === 'torrent'
          ? await createRoomAndUploadTorrent({ file: media.file, session: media.session }, draftNickname.trim(), setProgress)
          : await createScreenRoom(draftNickname.trim())
      if (media.kind === 'screen') stashScreenStream(room.roomID, media.stream)
      setNickname(room.nickname)
      localStorage.setItem('ss.nickname', room.nickname)
      navigate(`/room/${room.roomID}`)
    } catch (error) {
      discardPending(media)
      setResumed(null)
      // A file that changed under the picker is not a failed transfer, and
      // saying "try again" would send someone straight back into it.
      setError(t(isUnreadableFile(error) ? 'error.fileChanged' : 'home.failed'))
      setStep('drop')
      setProgress(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    selectFile(event.dataTransfer.files[0])
  }

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0])
  }

  return (
    <main
      className={`home-shell ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { if (shown === 'drop') { event.preventDefault(); setDragging(true) } }}
      onDragOver={(event) => { if (shown === 'drop') event.preventDefault() }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
      onDrop={onDrop}
    >
      <header className="home-header">
        <a className="home-wordmark" href="/">ss.giuli.dev</a>
        <div className="header-end">
          <BuildInfo label={t('home.source')} />
          <button className="header-language" aria-label={t('home.language')} onClick={() => t.setLanguage(t.language === 'en' ? 'pt-BR' : 'en')}>
            <span aria-hidden="true">{t.language === 'en' ? '🇺🇸' : '🇧🇷'}</span>{t.language === 'en' ? 'EN' : 'PT'}
          </button>
        </div>
      </header>

      {/* Kept out of the stage so the step it belongs to can dissolve without
          taking the input — and the click that opens it — down with it. */}
      <input ref={inputRef} hidden type="file" accept="video/*,.mkv" onChange={onChange} />

      <section className="home-stage" data-step={shown}>
        {/* The headline is the invitation, and once a source is being picked
            the invitation has been accepted. It gets out of the way — and
            gives the panel its room — until the picking is abandoned. */}
        <div className="collapse-slot">
          <div className="home-intro">
            <h1>{t('home.title')}</h1>
            <p>{t('home.guide')}</p>
          </div>
        </div>
        {/* Three ways in, side by side, and the middle one grows into whatever
            the chosen way still needs to ask. Nothing is stacked over anything:
            the control that was clicked becomes the panel. */}
        <div className="source-row" data-step={shown}>
          <button className="source-side primary-button raised" onClick={() => inputRef.current?.click()} {...aside}>
            {t('home.choose')}
          </button>
          <MorphPanel className="source-morph" sizeKey={shown} morphing={morphing}>
              {shown === 'drop' ? (
                // Bare on purpose: the pill it looks like is the panel's own
                // border and background, so opening it grows that same box
                // instead of trading a button for a surface.
                <button className="morph-trigger" onClick={() => { setError(''); setStep('torrent') }}>
                  <span className="magnet-glyph" aria-hidden="true">µ</span>{t('home.openTorrent')}
                </button>
              ) : null}

              {shown === 'torrent' ? (
                <div className="morph-step">
                  {/* The picker draws its own way back, because only it knows
                      whether that means the magnet it listed or leaving. */}
                  <TorrentPicker
                    maxFileBytes={MAX_UPLOAD_BYTES}
                    t={t}
                    initialSession={resumed?.session ?? null}
                    initialMagnet={resumed?.magnet ?? ''}
                    onExit={() => { setResumed(null); setStep('drop') }}
                    onPicked={(file, session, magnet) => {
                      setResumed(null)
                      setTorrentMagnet(magnet)
                      setDraftNickname(nickname)
                      setPendingMedia({ kind: 'torrent', file, session })
                      setStep('name')
                    }}
                  />
                </div>
              ) : null}

              {shown === 'name' && pendingMedia ? (
                <div className="morph-step">
                  <span className="dialog-file">{pendingMedia.kind === 'screen' ? t('home.screenDialog') : pendingMedia.file.name}</span>
                  <div className="morph-head">
                    <StepBack label={t('home.back')} onClick={stepBack} />
                    <h2 className="stage-title">{t('home.dialogTitle')}</h2>
                  </div>
                  <p className="stage-description">{t('home.dialogGuide')}</p>
                  <form onSubmit={(event) => { event.preventDefault(); void startUpload() }}>
                    <label htmlFor="nickname">{t('home.nickname')}</label>
                    <input id="nickname" className="sunken" autoFocus value={draftNickname} maxLength={64} placeholder={t('home.nicknamePlaceholder')} onChange={(event) => setDraftNickname(event.target.value)} />
                    <div className="stage-actions">
                      <Button type="submit" variant="primary">{t('home.continue')}</Button>
                    </div>
                  </form>
                </div>
              ) : null}

              {shown === 'starting' ? (
                <div className="morph-step is-centered">
                  {/* An MP4 is remuxed before it can be sent, and that is the
                      one part of starting a room with a length worth drawing.
                      Until it reports in there is nothing to measure, so the
                      wait is indeterminate and says so. */}
                  {progress?.phase === 'converting' ? (
                    <div className="progress-wrap" aria-label={t('home.preparing')}>
                      <div className="progress-copy"><span>{t('home.preparing')}</span><span>{progress.pct}%</span></div>
                      <div className="progress-track"><span style={{ width: `${progress.pct}%` }} /></div>
                    </div>
                  ) : (
                    <>
                      <span className="stage-spinner" aria-hidden="true" />
                      <strong>{t('home.preparing')}</strong>
                    </>
                  )}
                </div>
              ) : null}
          </MorphPanel>
          <button className="source-side torrent-button" onClick={startScreenRoom} {...aside}>
            <MonitorUp size={16} aria-hidden="true" />{t('home.shareScreen')}
          </button>
        </div>
        {/* Goes with the headline. Left merely transparent it would still hold
            its band of the page, and on a short window that is the band that
            pushes the panel off the bottom. */}
        <div className="collapse-slot">
          <p className="source-hint">{t('home.dropHint')}</p>
        </div>
        {error ? <div className="error-card" role="alert">{error}</div> : null}
      </section>
    </main>
  )
}

