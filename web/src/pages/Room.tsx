import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Room as LiveKitRoom } from 'livekit-client'
import { Chat } from '../chat/Chat'
import { StatusPill } from '../components/StatusPill'
import { UploadAvailability } from '../components/UploadAvailability'
import { useT } from '../i18n/useT'
import { Player } from '../player/Player'
import { useSync } from '../player/useSync'
import { startScreenShare } from '../screenshare'
import type { RoomInfo } from '../types'
import { subscribeUploadDone, subscribeUploadProgress, type RoomUploadProgress } from '../upload'

export function RoomPage() {
  const t = useT()
  const { id = '' } = useParams()
  const initialNickname = localStorage.getItem('ss.nickname') || ''
  const [nickname, setNickname] = useState(initialNickname)
  const [draftNickname, setDraftNickname] = useState(initialNickname)
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    // Old shared links may still contain ?nick=. Remove every query parameter
    // before it can linger in browser history, referrers, or screenshots.
    if (window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/rooms/${encodeURIComponent(id)}`, { signal: controller.signal }).then(async (response) => {
      if (response.status === 404) { setMissing(true); return }
      if (!response.ok) throw new Error('room request failed')
      setRoom(await response.json() as RoomInfo)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setMissing(true)
    })
    return () => controller.abort()
  }, [id])

  if (missing) return <EmptyRoom />
  if (!room) return <main className="center-state"><StatusPill status="connecting" label="Connecting" /></main>
  if (!nickname) {
    return (
      <main className="center-state"><div className="state-card raised">
        <h1>{t('room.join')}</h1>
        <input className="sunken text-field" value={draftNickname} onChange={(event) => setDraftNickname(event.target.value)} maxLength={64} />
        <button className="primary-button" onClick={() => { const value = draftNickname.trim(); if (value) { localStorage.setItem('ss.nickname', value); setNickname(value) } }}>{t('room.join')}</button>
      </div></main>
    )
  }
  return <ConnectedRoom room={room} nickname={nickname} />
}

function ConnectedRoom({ room, nickname }: { room: RoomInfo; nickname: string }) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const remoteTileRef = useRef<HTMLDivElement>(null)
  const sync = useSync(room.id, nickname, videoRef)
  const [liveRoom, setLiveRoom] = useState(room)
  const [chatOpen, setChatOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const [shareRoom, setShareRoom] = useState<LiveKitRoom | null>(null)
  const [shareError, setShareError] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<RoomUploadProgress | null>(null)
  const [uploadFailed, setUploadFailed] = useState(false)
  const mediaStatus = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status

  // Media and subtitle updates carry the current media status; each signal
  // means fresh room metadata is available.
  useEffect(() => {
    if (sync.roomVersion === 0) return
    const controller = new AbortController()
    void fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal }).then(async (response) => {
      if (response.ok) setLiveRoom(await response.json() as RoomInfo)
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.error('room refetch failed', error)
    })
    return () => controller.abort()
  }, [sync.roomVersion, room.id])

  // Show this tab's own background upload progress while it is running.
  useEffect(() => subscribeUploadProgress(room.id, setUploadProgress), [room.id])
  useEffect(() => subscribeUploadDone(room.id, (error) => {
    setUploadProgress(null)
    if (error) setUploadFailed(true)
  }), [room.id])

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/room/${room.id}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const shareScreen = async () => {
    setShareError(false)
    try {
      if (shareRoom) { await shareRoom.disconnect(); setShareRoom(null); return }
      const nextRoom = await startScreenShare(room.id, sync.memberId, sync.capability, (element) => {
        remoteTileRef.current?.replaceChildren(element)
      })
      setShareRoom(nextRoom)
    } catch { setShareError(true) }
  }

  if (uploadFailed) {
    return <main className="center-state"><div className="state-card error-card"><h1>{t('room.uploadFailed')}</h1><Link to="/">{t('room.new')}</Link></div></main>
  }
  if (mediaStatus === 'processing' || mediaStatus === 'uploading') {
    return <main className="center-state"><UploadAvailability progress={uploadProgress} t={t} /></main>
  }
  if (mediaStatus === 'error') {
    return <main className="center-state"><div className="state-card error-card"><h1>{t('room.error')}</h1><p>{liveRoom.errorMessage}</p><Link to="/">{t('room.new')}</Link></div></main>
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="room-heading"><span className="room-file">{liveRoom.fileName}</span></div>
        <div className="header-actions">
          {uploadProgress !== null ? <span className="upload-chip">{t('home.uploading')} {uploadProgress.pct}%</span> : null}
          {uploadFailed ? <span className="upload-chip is-error">{t('room.uploadFailed')}</span> : null}
          <StatusPill status={sync.buffering ? 'buffering' : sync.connected ? 'live' : 'connecting'} label={t(sync.buffering ? 'status.buffering' : sync.connected ? 'status.live' : 'status.connecting')} />
          <button onClick={copyLink}>{copied ? t('room.copied') : t('room.copy')}</button>
          <button onClick={shareScreen}>{shareRoom ? t('room.stopScreen') : t('room.shareScreen')}</button>
          <button onClick={() => setChatOpen((open) => !open)}>{t('chat.title')}</button>
        </div>
      </header>
      {shareError ? <div className="error-card compact">{t('error.screenshare')}</div> : null}
      <div className="room-layout">
        <section className="media-column">
          <Player room={liveRoom} isController={sync.isController} videoRef={videoRef} send={sync.send} t={t} />
          <div ref={remoteTileRef} className="screen-tile" />
          <div className="presence-row">
            {sync.members.map((member) => (
              <span key={member.id} className={`member-chip ${member.id === sync.controllerId ? 'is-controller' : ''}`}>
                {member.nickname}{member.id === sync.controllerId ? ' ●' : ''}
              </span>
            ))}
          </div>
        </section>
        <Chat open={chatOpen} onClose={() => setChatOpen(false)} messages={sync.messages} onSend={(text) => sync.send('chat', { text })} t={t} />
      </div>
    </main>
  )
}

function EmptyRoom() {
  const t = useT()
  return <main className="center-state"><div className="state-card raised"><h1>{t('room.expired')}</h1><Link className="primary-button" to="/">{t('room.new')}</Link></div></main>
}
