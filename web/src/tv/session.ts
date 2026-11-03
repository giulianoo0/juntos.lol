import type { TvAccount, TvDevice } from './api'

/**
 * Where the TV is: showing a code to be linked, checking the token it kept,
 * waiting for a phone to mirror a room, or in that room.
 */
export type TvSession =
  | { screen: 'pairing' }
  | { screen: 'checking'; token: string }
  | { screen: 'waiting'; token: string; account: TvAccount; device: TvDevice }
  | { screen: 'room'; token: string; account: TvAccount; device: TvDevice; roomId: string; ticket: string }

export type TvEvent =
  | { type: 'linked'; token: string; account: TvAccount; device: TvDevice }
  | { type: 'me'; account: TvAccount; device: TvDevice }
  | { type: 'cast'; roomId: string; ticket: string }
  | { type: 'stop' }
  /** The room let the TV go: closed, gone, or it was put out. */
  | { type: 'roomClosed'; roomId: string }
  | { type: 'revoked' }

export function initialSession(token: string | null): TvSession {
  return token ? { screen: 'checking', token } : { screen: 'pairing' }
}

export function sessionReducer(state: TvSession, event: TvEvent): TvSession {
  switch (event.type) {
    case 'revoked':
      return { screen: 'pairing' }
    case 'linked':
      return { screen: 'waiting', token: event.token, account: event.account, device: event.device }
    case 'me':
      return state.screen === 'checking' ? { screen: 'waiting', token: state.token, account: event.account, device: event.device } : state
    case 'cast':
      if (state.screen !== 'waiting' && state.screen !== 'room') return state
      return { screen: 'room', token: state.token, account: state.account, device: state.device, roomId: event.roomId, ticket: event.ticket }
    case 'stop':
      return state.screen === 'room' ? { screen: 'waiting', token: state.token, account: state.account, device: state.device } : state
    case 'roomClosed':
      return state.screen === 'room' && state.roomId === event.roomId
        ? { screen: 'waiting', token: state.token, account: state.account, device: state.device }
        : state
  }
}
