import { useEffect, useRef } from 'react'

import type { ChatMessage } from '../types'
import { playMessageChime } from '../ui/chime'

/**
 * Sounds once for each message someone else sends while the room is
 * connected. The history that arrives with a welcome, on joining or on a
 * reconnect, only moves the mark: those were not sent just now.
 */
export function useMessageChime(messages: ChatMessage[], connected: boolean, nickname: string): void {
  const seenRef = useRef(0)
  const wasConnectedRef = useRef(false)

  useEffect(() => {
    const fresh = wasConnectedRef.current && connected ? messages.slice(seenRef.current) : []
    seenRef.current = messages.length
    wasConnectedRef.current = connected
    if (fresh.some((message) => message.author !== nickname)) playMessageChime()
  }, [messages, connected, nickname])
}
