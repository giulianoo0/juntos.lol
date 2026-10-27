import { createContext, useContext } from 'react'
import type { RoomViewModel } from '../model'
import type { Target } from './layout'
import type { RoomStrings } from './strings'

/** What the room's pieces share: the model, its words, and the viewer's
    own choices (the pin, stepping out of the spotlight). */
export interface RoomUi {
  vm: RoomViewModel
  strings: RoomStrings
  pin: Target | null
  setPin: (target: Target | null) => void
  leftSpotlight: boolean
  setLeftSpotlight: (left: boolean) => void
  /** Whose ids are in the spotlight, to mark their tile. */
  spotlit: Target | null
  nameOf: (memberId: string) => string
  /** Shrinks the call into the corner over someone's profile. */
  viewProfile: (accountId: number) => void
}

export const RoomUiContext = createContext<RoomUi | null>(null)

export function useRoomUi(): RoomUi {
  const ui = useContext(RoomUiContext)
  if (!ui) throw new Error('useRoomUi outside RoomView')
  return ui
}

export const sameTarget = (a: Target | null, b: Target | null) =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id
