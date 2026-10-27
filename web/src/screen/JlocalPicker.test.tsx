import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { JlocalPicker } from './JlocalPicker'

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

afterEach(() => vi.unstubAllGlobals())

describe('JlocalPicker', () => {
  it('holds the place of the screens while jlocal lists them', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<JlocalPicker onPick={vi.fn()} onExit={vi.fn()} t={t} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })

  it('while the share starts, the button keeps its words and says it is working', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<JlocalPicker onPick={vi.fn()} onExit={vi.fn()} busy t={t} />)
    expect(screen.getByRole('button', { name: 'Compartilhar' })).toHaveAttribute('aria-busy', 'true')
  })
})
