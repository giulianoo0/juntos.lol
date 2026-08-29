import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import type { RoomPreparation } from '../types'
import { UploadAvailability } from './UploadAvailability'

const t = Object.assign((key: string) => translate('en', key), {
  language: 'en' as const,
  setLanguage: vi.fn(),
}) as Translator

const MB = 1024 * 1024

function renderPrep(preparation: RoomPreparation) {
  return render(<UploadAvailability t={t} progress={null} preparation={preparation} />)
}

describe('UploadAvailability', () => {
  it('waits quietly until any byte count exists', () => {
    render(<UploadAvailability t={t} progress={null} />)

    expect(screen.getByText('Waiting for the initial upload...')).toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('measures the wait against the point playback can start, not the whole file', () => {
    // 30 MB of a 600 MB file, needing 60 MB to play: half way to playable,
    // and only 5% of the way through the transfer.
    renderPrep({
      sourceBytes: 600 * MB,
      receivedBytes: 30 * MB,
      previewPhase: 'segmenting',
      previewTargetBytes: 60 * MB,
    })

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('Starts playing in')).toBeInTheDocument()
  })

  it('names the phase the source is actually in', () => {
    const { rerender } = renderPrep({ sourceBytes: 100 * MB, receivedBytes: MB, previewPhase: 'probing' })
    expect(screen.getByText('Analysing what has arrived…')).toBeInTheDocument()

    rerender(<UploadAvailability t={t} progress={null} preparation={{
      sourceBytes: 100 * MB, receivedBytes: 2 * MB, previewPhase: 'segmenting',
    }} />)
    expect(screen.getByText('Building the first segment…')).toBeInTheDocument()
  })

  it('says outright when a source cannot be previewed, and measures the whole file', () => {
    // This is the case that used to show a bar stuck at 100% for ever: an MP4
    // whose index trails its media only plays once every byte has landed.
    renderPrep({
      sourceBytes: 400 * MB,
      receivedBytes: 100 * MB,
      previewPhase: 'unavailable',
    })

    expect(screen.getByText(/cannot be previewed/)).toBeInTheDocument()
    expect(screen.getByText('Finishes in')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  })

  it('falls back to the file itself while the playable point is unknown', () => {
    renderPrep({ sourceBytes: 200 * MB, receivedBytes: 50 * MB, previewPhase: 'receiving' })

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('Finishes in')).toBeInTheDocument()
  })

  it('prefers the server count over this tab, so every viewer sees the same figure', () => {
    render(<UploadAvailability
      t={t}
      progress={{ pct: 90, bytesUploaded: 90 * MB, bytesTotal: 100 * MB }}
      preparation={{ sourceBytes: 100 * MB, receivedBytes: 10 * MB, previewPhase: 'receiving' }}
    />)

    // The bar tracks the server's 10 MB, not this tab's 90 MB.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
  })

  it('uses this tab as the fallback when the server has published nothing', () => {
    render(<UploadAvailability
      t={t}
      progress={{ pct: 20, bytesUploaded: 20 * MB, bytesTotal: 100 * MB }}
    />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
  })

  describe('estimate', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
    afterEach(() => { vi.useRealTimers() })

    it('declines to guess before it has watched the transfer', () => {
      renderPrep({ sourceBytes: 600 * MB, receivedBytes: 10 * MB, previewTargetBytes: 60 * MB })

      expect(screen.getByText('estimating…')).toBeInTheDocument()
    })

    it('predicts from the rate it observed', () => {
      const { rerender } = renderPrep({
        sourceBytes: 600 * MB, receivedBytes: 10 * MB, previewTargetBytes: 60 * MB,
      })

      // 10 MB arrive over 10 seconds, so the remaining 40 MB take about 40s.
      act(() => { vi.advanceTimersByTime(10_000) })
      rerender(<UploadAvailability t={t} progress={null} preparation={{
        sourceBytes: 600 * MB, receivedBytes: 20 * MB, previewTargetBytes: 60 * MB,
      }} />)

      expect(screen.getByText('under a minute')).toBeInTheDocument()
    })

    it('rounds a long wait to minutes rather than pretending to be exact', () => {
      const { rerender } = renderPrep({
        sourceBytes: 6000 * MB, receivedBytes: 10 * MB, previewTargetBytes: 610 * MB,
      })

      // 2 MB/s with 600 MB to go is 300 seconds.
      act(() => { vi.advanceTimersByTime(5_000) })
      rerender(<UploadAvailability t={t} progress={null} preparation={{
        sourceBytes: 6000 * MB, receivedBytes: 20 * MB, previewTargetBytes: 610 * MB,
      }} />)

      expect(screen.getByText('~5 min')).toBeInTheDocument()
    })

    it('forgets the previous source when the count restarts', () => {
      const { rerender } = renderPrep({
        sourceBytes: 600 * MB, receivedBytes: 300 * MB, previewTargetBytes: 60 * MB,
      })
      act(() => { vi.advanceTimersByTime(10_000) })

      // A swapped source starts from zero; carrying the old samples over would
      // read as a huge negative rate.
      rerender(<UploadAvailability t={t} progress={null} preparation={{
        sourceBytes: 600 * MB, receivedBytes: 0, previewTargetBytes: 60 * MB,
      }} />)

      expect(screen.getByText('estimating…')).toBeInTheDocument()
    })
  })
})
