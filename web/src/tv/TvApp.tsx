import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { Face } from '../room/ui/Face'
import { Loading, Skeleton } from '../ui/Shimmer'
import { exitTvApp, listenForShell, registerTvKeys } from './keys'
import { PairingScreen } from './PairingScreen'
import { installPointer } from './pointer'
import { TvRoom, type RoomRemote } from './TvRoom'
import { useRemote } from './useRemote'
import { useTvSession } from './useTvSession'
import styles from './tv.module.css'

/** The TV's page: the ten-foot scale and dark ground, the remote, and its screens. */
export function TvApp() {
  useEffect(() => {
    const root = document.documentElement
    const theme = root.dataset.theme
    root.dataset.tv = ''
    root.dataset.theme = 'dark'
    registerTvKeys()
    const stopShell = listenForShell()
    const stopPointer = installPointer()
    return () => {
      delete root.dataset.tv
      if (theme === undefined) delete root.dataset.theme
      else root.dataset.theme = theme
      stopShell()
      stopPointer()
    }
  }, [])

  const t = useT()
  const { session, mix, linked, roomClosed, changeMix } = useTvSession()
  const remoteRef = useRef<RoomRemote | null>(null)
  const [confirm, setConfirm] = useState(false)
  const inRoom = session.screen === 'room'
  const roomId = inRoom ? session.roomId : ''

  useRemote({
    onBack: () => {
      if (confirm) { setConfirm(false); return }
      if (inRoom && remoteRef.current?.back()) return
      setConfirm(true)
    },
    onMenu: () => { if (inRoom) remoteRef.current?.menu() },
    onMedia: (action) => { if (inRoom) remoteRef.current?.media(action) },
  })
  const leaveRoom = useCallback(() => roomClosed(roomId), [roomClosed, roomId])

  return (
    <>
      {session.screen === 'pairing' ? <PairingScreen onLinked={linked} /> : null}
      {session.screen === 'checking' ? (
        <Loading label={t('status.loading')} className={styles.screen}><Skeleton width="100%" height="100%" /></Loading>
      ) : null}
      {session.screen === 'waiting' ? (
        <main className={styles.waiting}>
          <Face id={String(session.account.id)} avatar={session.account.avatar} size={260} still={false} />
          <h1 className={styles.waitingName}>{session.account.nickname}</h1>
        </main>
      ) : null}
      {session.screen === 'room' ? (
        <TvRoom
          key={session.roomId}
          roomId={session.roomId}
          ticket={session.ticket}
          token={session.token}
          account={session.account}
          mix={mix}
          onMix={changeMix}
          onClosed={leaveRoom}
          remoteRef={remoteRef}
        />
      ) : null}
      {confirm ? (
        <ConfirmLeave
          title={t(inRoom ? 'tv.stopTitle' : 'tv.exitTitle')}
          leave={t(inRoom ? 'tv.stop' : 'tv.exit')}
          stay={t('tv.stay')}
          onStay={() => setConfirm(false)}
          onLeave={() => {
            setConfirm(false)
            if (inRoom) leaveRoom()
            else exitTvApp()
          }}
        />
      ) : null}
    </>
  )
}

/** The question Back asks at the top: the focus starts on staying, so a second press never leaves by accident. */
function ConfirmLeave({ title, leave, stay, onStay, onLeave }: { title: string; leave: string; stay: string; onStay: () => void; onLeave: () => void }) {
  const titleId = 'tv-confirm-title'
  return (
    <div className={styles.confirmVeil}>
      <div className={styles.confirm} role="alertdialog" aria-labelledby={titleId} data-tv-overlay="">
        <h2 id={titleId}>{title}</h2>
        <div className={styles.confirmActions}>
          <button type="button" className={styles.confirmButton} autoFocus onClick={onStay}>{stay}</button>
          <button type="button" className={styles.confirmButton} data-tone="danger" onClick={onLeave}>{leave}</button>
        </div>
      </div>
    </div>
  )
}
