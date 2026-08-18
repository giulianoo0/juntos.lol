import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { UploadAvailability } from './UploadAvailability'

const t = Object.assign((key: string) => translate('en', key), {
  language: 'en' as const,
  setLanguage: vi.fn(),
}) as Translator

describe('UploadAvailability', () => {
  it('shows bytes and percentage toward the configured stream threshold', () => {
    render(<UploadAvailability t={t} progress={{
      pct: 5,
      bytesUploaded: 512 * 1024,
      bytesTotal: 10 * 1024 * 1024,
      streamStartBytes: 1024 * 1024,
    }} />)

    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('0.50 MB / 1.00 MB')).toBeInTheDocument()
    expect(screen.getByText('Uploading 5%')).toBeInTheDocument()
    expect(screen.queryByText('Processing')).not.toBeInTheDocument()
  })

  it('explains that the first segment is being created after the threshold', () => {
    render(<UploadAvailability t={t} progress={{
      pct: 10,
      bytesUploaded: 2 * 1024 * 1024,
      bytesTotal: 20 * 1024 * 1024,
      streamStartBytes: 1024 * 1024,
    }} />)

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('Initial data received. Creating the first playable segment...')).toBeInTheDocument()
  })

  it('shows a neutral waiting state when progress belongs to another device', () => {
    render(<UploadAvailability t={t} progress={null} />)

    expect(screen.getByText('Waiting for the initial upload...')).toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })
})
