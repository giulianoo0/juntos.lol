import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { BrowserNotice } from './BrowserNotice'
import { isUnsupportedBrowser } from '../browser'

const t = Object.assign((key: string) => translate('en', key), {
  language: 'en' as const,
  setLanguage: vi.fn(),
}) as Translator

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0'
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

function useAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value })
}

describe('BrowserNotice', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('recognizes the engine that cannot play the media', () => {
    useAgent(FIREFOX)
    expect(isUnsupportedBrowser()).toBe(true)
    for (const agent of [CHROME, SAFARI]) {
      useAgent(agent)
      expect(isUnsupportedBrowser()).toBe(false)
    }
  })

  it('warns on Firefox', () => {
    useAgent(FIREFOX)
    render(<BrowserNotice t={t} />)
    expect(screen.getByText(/firefox is not supported/i)).toBeInTheDocument()
  })

  it('stays out of the way on browsers that work', () => {
    useAgent(CHROME)
    const { container } = render(<BrowserNotice t={t} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays dismissed across visits', () => {
    useAgent(FIREFOX)
    const { unmount } = render(<BrowserNotice t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/firefox is not supported/i)).not.toBeInTheDocument()
    unmount()

    render(<BrowserNotice t={t} />)
    expect(screen.queryByText(/firefox is not supported/i)).not.toBeInTheDocument()
  })

  it('can still be closed when storage is unavailable', () => {
    useAgent(FIREFOX)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    render(<BrowserNotice t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText(/firefox is not supported/i)).not.toBeInTheDocument()
  })
})
