import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { WorkerProbes } from './WorkerProbes'

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

describe('WorkerProbes', () => {
  it('holds the place of a measure still running, and shows the ones that came back', () => {
    render(<WorkerProbes t={t} probes={[
      { id: 'w_alpha1', readBase: 'https://a.juntos.lol', holds: false, state: 'testing' },
      { id: 'w_beta22', readBase: 'https://b.juntos.lol', holds: false, state: 'ok', mbit: 80, ttfbMs: 40 },
    ]} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('80 Mbit/s · 40ms')).toBeInTheDocument()
    expect(screen.queryByText(/testando|Medindo/)).not.toBeInTheDocument()
  })
})
