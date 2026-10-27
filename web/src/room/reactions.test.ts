import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './model'
import { REACTIONS, freshReactions, isReaction, reactionSrc, splitReactions } from './reactions'

const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, authorId: 'ana', author: 'Ana', text, at: 1_000, ...extra,
})

describe('reactions', () => {
  it('offers six reactions, each with its Apple picture in the app', () => {
    expect(REACTIONS).toEqual(['👏', '😂', '😮', '❤️', '🔥', '🍿'])
    expect(REACTIONS.map(reactionSrc)).toEqual([
      '/emoji/1f44f.png', '/emoji/1f602.png', '/emoji/1f62e.png', '/emoji/2764-fe0f.png', '/emoji/1f525.png', '/emoji/1f37f.png',
    ])
    expect([reactionSrc('🦆'), reactionSrc('constructor')]).toEqual([null, null])
  })

  it('tells a reaction from a message that only mentions one', () => {
    expect(isReaction('🔥')).toBe(true)
    expect(isReaction(' 🔥 ')).toBe(true)
    expect(isReaction('🔥🔥')).toBe(false)
    expect(isReaction('pipoca pronta 🍿')).toBe(false)
    expect(isReaction('constructor')).toBe(false)
  })

  it('takes the reactions out of the chat and gives them to whoever sent them', () => {
    const { chat, reactions } = splitReactions([
      message('1', 'oi'),
      message('2', '😂', { authorId: 'bruno', at: 2_000 }),
      message('3', '🍿', { system: true, authorId: '' }),
    ])
    expect(chat.map(({ id }) => id)).toEqual(['1', '3'])
    expect(reactions).toEqual([{ id: '2', memberId: 'bruno', emoji: '😂', at: 2_000 }])
  })

  it('floats only what was not seen yet and is still recent', () => {
    const reactions = [
      { id: 'old', memberId: 'ana', emoji: '🔥', at: 1_000 },
      { id: 'seen', memberId: 'ana', emoji: '😂', at: 9_500 },
      { id: 'new', memberId: 'ana', emoji: '👏', at: 9_800 },
    ]
    expect(freshReactions(reactions, new Set(['seen']), 10_000).map(({ id }) => id)).toEqual(['new'])
  })
})
