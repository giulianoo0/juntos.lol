import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './Chat'
import { translate, type Translator } from '../i18n/useT'

const t = Object.assign((key: string) => translate('en', key), { language: 'en' as const, setLanguage: vi.fn() }) as Translator

const entry = (text: string, at = '2026-09-03T00:00:00Z') => ({ author: 'giuli', text, at })

/** jsdom lays nothing out, so the list's geometry is stated. */
function sizeList(list: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => clientHeight })
}

describe('Chat', () => {
  it('renders messages and sends on Enter', () => {
    const onSend = vi.fn()
    render(<Chat open messages={[{ author: 'giuli', text: 'hello', at: 'now' }]} onClose={() => undefined} onSend={onSend} t={t} />)
    expect(screen.getByText('hello')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Write a message'), { target: { value: 'oi' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Write a message'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('oi')
  })

  it('uses drawer and reduced motion classes from media queries', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width') || query.includes('reduced-motion'),
      media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
    }))
    const { container } = render(<Chat open messages={[]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    expect(container.firstChild).toHaveClass('chat-drawer', 'reduced-motion')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps the newest message in view for a reader at the bottom', () => {
    const { container, rerender } = render(<Chat open messages={[entry('one')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    const list = container.querySelector('.chat-messages') as HTMLElement
    sizeList(list, 600, 200)
    rerender(<Chat open messages={[entry('one'), entry('two')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    expect(list.scrollTop).toBe(600)
  })

  it('leaves a reader who scrolled up where they are', () => {
    const { container, rerender } = render(<Chat open messages={[entry('one')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    const list = container.querySelector('.chat-messages') as HTMLElement
    sizeList(list, 600, 200)
    list.scrollTop = 100
    fireEvent.scroll(list)
    rerender(<Chat open messages={[entry('one'), entry('two')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    expect(list.scrollTop).toBe(100)
  })

  it('follows again once the reader sends a message', () => {
    const { container, rerender } = render(<Chat open messages={[entry('one')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    const list = container.querySelector('.chat-messages') as HTMLElement
    sizeList(list, 600, 200)
    list.scrollTop = 100
    fireEvent.scroll(list)
    fireEvent.change(screen.getByPlaceholderText('Write a message'), { target: { value: 'oi' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Write a message'), { key: 'Enter' })
    rerender(<Chat open messages={[entry('one'), entry('oi')]} onClose={() => undefined} onSend={() => undefined} t={t} />)
    expect(list.scrollTop).toBe(600)
  })
})
