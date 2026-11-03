import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { clearToken, fetchTvMe, loadToken, saveToken, type TvAccount, type TvDevice } from './api'
import { openTvChannel, type TvChannel } from './channel'
import { DEFAULT_MIX, type Mix } from './mix'
import { initialSession, sessionReducer, type TvSession } from './session'

/** A /tv/me that failed for any reason but a revoked token is asked again after this long. */
const ME_RETRY_MS = 5_000

export interface TvSessionApi {
  session: TvSession
  mix: Mix
  /** The phone linked this TV: the token is kept from now on. */
  linked(link: { token: string; account: TvAccount; device: TvDevice }): void
  /** The room let the TV go by itself (closed, gone, put out). */
  roomClosed(roomId: string): void
  /** A change made on the TV, sent to the server for the phone to see. */
  changeMix(mix: Mix): void
}

/** The TV's whole life outside the room: the token, the account, the socket that casts. */
export function useTvSession(): TvSessionApi {
  const [session, dispatch] = useReducer(sessionReducer, loadToken(), initialSession)
  const [mix, setMix] = useState<Mix>(DEFAULT_MIX)
  const channelRef = useRef<TvChannel | null>(null)
  const roomId = session.screen === 'room' ? session.roomId : null
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId

  const token = session.screen === 'pairing' ? null : session.token
  useEffect(() => {
    if (token) saveToken(token)
    else clearToken()
  }, [token])

  const checking = session.screen === 'checking' ? session.token : null
  useEffect(() => {
    if (!checking) return
    let live = true
    let retry: number | null = null
    const ask = () => {
      fetchTvMe(checking).then((answer) => {
        if (!live) return
        if (answer === 'revoked') dispatch({ type: 'revoked' })
        else dispatch({ type: 'me', account: answer.account, device: answer.device })
      }).catch(() => {
        if (live) retry = window.setTimeout(ask, ME_RETRY_MS)
      })
    }
    ask()
    return () => {
      live = false
      if (retry !== null) window.clearTimeout(retry)
    }
  }, [checking])

  const channelToken = session.screen === 'waiting' || session.screen === 'room' ? session.token : null
  useEffect(() => {
    if (!channelToken) return
    let checkingToken = false
    const channel = openTvChannel(channelToken, {
      onOpen: () => { channel.send({ type: 'state', roomId: roomIdRef.current }) },
      onRefused: () => {
        if (checkingToken) return
        checkingToken = true
        void fetchTvMe(channelToken).then((answer) => {
          if (answer === 'revoked') dispatch({ type: 'revoked' })
        }).catch(() => undefined).finally(() => { checkingToken = false })
      },
      onMessage: (message) => {
        switch (message.type) {
          case 'cast':
            if (typeof message.roomId === 'string' && typeof message.ticket === 'string') {
              dispatch({ type: 'cast', roomId: message.roomId, ticket: message.ticket })
            }
            break
          case 'stop':
            dispatch({ type: 'stop' })
            break
          case 'mix':
            if (message.mix && typeof message.mix === 'object') setMix(message.mix as Mix)
            break
          case 'revoked':
            dispatch({ type: 'revoked' })
            break
        }
      },
    })
    channelRef.current = channel
    return () => {
      channel.close()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [channelToken])

  const firstState = useRef(true)
  useEffect(() => {
    // The socket says where the TV is as it opens; this is for each move after.
    if (firstState.current) { firstState.current = false; return }
    channelRef.current?.send({ type: 'state', roomId })
  }, [roomId])

  const linked = useCallback((link: { token: string; account: TvAccount; device: TvDevice }) => {
    dispatch({ type: 'linked', ...link })
  }, [])
  const roomClosed = useCallback((closedId: string) => dispatch({ type: 'roomClosed', roomId: closedId }), [])
  const changeMix = useCallback((next: Mix) => {
    setMix(next)
    channelRef.current?.send({ type: 'mix', mix: next })
  }, [])

  return { session, mix, linked, roomClosed, changeMix }
}
