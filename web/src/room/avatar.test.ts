import { afterEach, describe, expect, it, vi } from 'vitest'
import { avatarOf, loadPickedAvatar, reactionMood, savePickedAvatar } from './avatar'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('avatarOf', () => {
  it('draws the avatar the member has', () => {
    expect(avatarOf('cat-preto.beanie', 'm-1')).toEqual({ kind: 'cat', color: 'preto', accessory: 'beanie' })
  })

  it('gives someone without one the same default every time, picked by their id', () => {
    expect(avatarOf(undefined, 'm-ana')).toEqual(avatarOf('', 'm-ana'))
    expect(avatarOf('not-a-kind.hat', 'm-ana')).toEqual(avatarOf(undefined, 'm-ana'))
    const kinds = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => avatarOf(undefined, `m-${id}`).kind))
    expect(kinds.size).toBeGreaterThan(3)
  })
})

describe('picked avatar', () => {
  it('keeps the pick in this browser', () => {
    expect(loadPickedAvatar()).toBeNull()
    savePickedAvatar('owl.crown')
    expect(loadPickedAvatar()).toBe('owl.crown')
  })

  it('forgets a stored value it cannot draw', () => {
    localStorage.setItem('ss.avatar', 'https://x.test/a.png')
    expect(loadPickedAvatar()).toBeNull()
  })

  it('goes on without storage when the browser refuses it', () => {
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => savePickedAvatar('owl')).not.toThrow()
    expect(loadPickedAvatar()).toBeNull()
  })
})

describe('reactionMood', () => {
  it('cheers for laughs, love, fire and claps, wonders at a gasp', () => {
    for (const emoji of ['😂', '❤️', '🔥', '👏']) expect(reactionMood(emoji), emoji).toBe('happy')
    expect(reactionMood('😮')).toBe('thinking')
    expect(reactionMood('🍿')).toBeNull()
  })
})
