import { lazy, useEffect, useState } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { useT } from '../i18n/useT'
import styles from './RoomHost.module.css'

const RoomPage = lazy(() => import('../pages/Room').then((module) => ({ default: module.RoomPage })))

/**
 * The room lives above the routes. On `/room/:id` it is the page; once you
 * are in the call, any other page of juntos opens behind it while the call
 * closes into the bottom right corner, still live, and a click on it comes
 * back.
 */
export function RoomHost() {
  const t = useT()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const here = matchPath('/room/:id', pathname)?.params.id ?? null
  const [kept, setKept] = useState<string | null>(here)
  const [inCall, setInCall] = useState(false)
  useEffect(() => { if (here) setKept(here) }, [here])

  const id = here ?? (inCall ? kept : null)
  if (!id) return null
  const away = here === null
  const back = t('room.backToRoom')
  return (
    <>
      <div className={styles.host} data-away={away || undefined} {...(away ? { inert: '' } : {})}>
        <RoomPage key={id} id={id} onInCall={setInCall} />
      </div>
      {away ? <button type="button" className={styles.back} aria-label={back} title={back} onClick={() => navigate(`/room/${id}`)} /> : null}
    </>
  )
}
