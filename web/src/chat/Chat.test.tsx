import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Chat } from './Chat'
import { translate, type Translator } from '../i18n/useT'

const t = Object.assign((key: string) => translate('en', key), { language: 'en' as const, setLanguage: vi.fn() }) as Translator

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
})
