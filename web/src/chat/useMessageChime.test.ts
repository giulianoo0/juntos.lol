import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '../types'

vi.mock('../ui/chime', () => ({ playMessageChime: vi.fn(), playJoinChime: vi.fn() }))

import { playMessageChime } from '../ui/chime'
import { useMessageChime } from './useMessageChime'

const message = (author: string, text: string): ChatMessage => ({ author, text, at: new Date().toISOString() })

describe('useMessageChime', () => {
  beforeEach(() => vi.mocked(playMessageChime).mockClear())

  it('sounds for a message from someone else', () => {
    const { rerender } = renderHook(
      ({ messages, connected }) => useMessageChime(messages, connected, 'me'),
      { initialProps: { messages: [] as ChatMessage[], connected: true } },
    )
    rerender({ messages: [message('them', 'hi')], connected: true })
    expect(playMessageChime).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for my own message', () => {
    const { rerender } = renderHook(
      ({ messages }) => useMessageChime(messages, true, 'me'),
      { initialProps: { messages: [] as ChatMessage[] } },
    )
    rerender({ messages: [message('me', 'hi')] })
    expect(playMessageChime).not.toHaveBeenCalled()
  })

  it('stays quiet for the history a welcome brings, then sounds for what follows', () => {
    const history = [message('them', 'earlier'), message('them', 'still earlier')]
    const { rerender } = renderHook(
      ({ messages, connected }) => useMessageChime(messages, connected, 'me'),
      { initialProps: { messages: [] as ChatMessage[], connected: false } },
    )
    rerender({ messages: history, connected: true })
    expect(playMessageChime).not.toHaveBeenCalled()
    rerender({ messages: [...history, message('them', 'now')], connected: true })
    expect(playMessageChime).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for the history a reconnect brings', () => {
    const before = [message('them', 'one')]
    const { rerender } = renderHook(
      ({ messages, connected }) => useMessageChime(messages, connected, 'me'),
      { initialProps: { messages: before, connected: true } },
    )
    rerender({ messages: before, connected: false })
    rerender({ messages: [...before, message('them', 'while away')], connected: true })
    expect(playMessageChime).not.toHaveBeenCalled()
  })
})
