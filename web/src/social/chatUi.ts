import { useSyncExternalStore } from 'react'

/** Whether the messages panel is open, and on whom. */
export interface ChatUi {
  open: boolean
  friendId: number | null
}

let state: ChatUi = { open: false, friendId: null }
const listeners = new Set<() => void>()

function publish(next: ChatUi) {
  state = next
  for (const listener of listeners) listener()
}

export function openChat(friendId: number | null = null) {
  publish({ open: true, friendId })
}

export function closeChat() {
  publish({ ...state, open: false })
}

export function showList() {
  publish({ open: true, friendId: null })
}

export function useChatUi(): ChatUi {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => state)
}
