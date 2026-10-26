import type { ChatMessage } from '../model'

/** Discord's: a pause this long starts a new head even for the same person. */
const RUN_GAP_MS = 7 * 60_000

export interface ChatLine extends ChatMessage {
  /** Draws the avatar, the name and the hour; a follow-up only its words. */
  head: boolean
}

export function groupChat(messages: ChatMessage[]): ChatLine[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    const follows = !message.system && previous !== undefined && !previous.system &&
      previous.authorId === message.authorId && message.at - previous.at < RUN_GAP_MS
    return { ...message, head: !message.system && !follows }
  })
}

const two = (value: number) => String(value).padStart(2, '0')

/** The hour beside a name in the chat: `21:06`. */
export function clockOf(at: number): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** The header's clock: `12:40`, `1:12:40`. */
export function elapsedOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}
