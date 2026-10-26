import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../model'
import { clockOf, elapsedOf, groupChat } from './chatGroups'

const at = (minute: number) => Date.UTC(2026, 9, 26, 21, minute)
const message = (id: string, authorId: string, minute: number, system = false): ChatMessage => ({
  id, authorId, author: authorId, text: id, at: at(minute), system,
})

describe('groupChat', () => {
  it('heads a run of one person with their name, and runs the rest under it', () => {
    const lines = groupChat([message('1', 'ana', 6), message('2', 'giu', 6), message('3', 'bruno', 7), message('4', 'bruno', 7)])
    expect(lines.map(({ id, head }) => [id, head])).toEqual([['1', true], ['2', true], ['3', true], ['4', false]])
  })

  it('starts a new head after a long pause, as Discord does', () => {
    const lines = groupChat([message('1', 'ana', 0), message('2', 'ana', 8)])
    expect(lines.map(({ head }) => head)).toEqual([true, true])
  })

  it('breaks a run at a line of the room', () => {
    const lines = groupChat([message('1', 'ana', 0), message('2', '', 0, true), message('3', 'ana', 1)])
    expect(lines.map(({ head }) => head)).toEqual([true, false, true])
  })
})

describe('clockOf', () => {
  it('writes the hour as the chat shows it', () => {
    expect(clockOf(new Date(2026, 9, 26, 9, 5).getTime())).toBe('09:05')
  })
})

describe('elapsedOf', () => {
  it('counts minutes and seconds, then hours', () => {
    expect(elapsedOf(65_000)).toBe('1:05')
    expect(elapsedOf(4_360_000)).toBe('1:12:40')
  })

  it('never shows a negative time', () => {
    expect(elapsedOf(-5_000)).toBe('0:00')
  })
})
