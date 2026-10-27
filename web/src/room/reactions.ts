import type { ChatMessage, Reaction } from './model'

/** What the dock offers. A reaction travels as a chat line holding only
    the emoji; the room takes it out of the chat and floats it over the
    tile of whoever sent it. */
export const REACTIONS = ['👏', '😂', '😮', '❤️', '🔥', '🍿'] as const

// The file names of `emoji-datasource-apple` (public/emoji/<unified>.png).
const UNIFIED: Record<string, string> = {
  '👏': '1f44f',
  '😂': '1f602',
  '😮': '1f62e',
  '❤️': '2764-fe0f',
  '🔥': '1f525',
  '🍿': '1f37f',
}

/** How long a reaction counts as just sent: older ones (the history a
    welcome brings) never float. */
export const FRESH_MS = 8_000

export function reactionSrc(emoji: string): string | null {
  return Object.hasOwn(UNIFIED, emoji) ? `/emoji/${UNIFIED[emoji]}.png` : null
}

export function isReaction(text: string): boolean {
  return Object.hasOwn(UNIFIED, text.trim())
}

export function splitReactions(messages: ChatMessage[]): { chat: ChatMessage[]; reactions: Reaction[] } {
  const chat: ChatMessage[] = []
  const reactions: Reaction[] = []
  for (const message of messages) {
    if (!message.system && isReaction(message.text)) {
      reactions.push({ id: message.id, memberId: message.authorId, emoji: message.text.trim(), at: message.at })
    } else {
      chat.push(message)
    }
  }
  return { chat, reactions }
}

export function freshReactions(reactions: Reaction[], seen: ReadonlySet<string>, now: number): Reaction[] {
  return reactions.filter((reaction) => !seen.has(reaction.id) && now - reaction.at < FRESH_MS)
}
