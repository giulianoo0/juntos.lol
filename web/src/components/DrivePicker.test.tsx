import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Translator } from '../i18n/useT'
import { DrivePicker } from './DrivePicker'

vi.mock('../upload', () => ({ changeRoomSource: vi.fn(), startRoomUpload: vi.fn() }))

const FOLDER = 'f'.repeat(30)
const VIDEO = 'v'.repeat(30)
const SUBTITLE = 's'.repeat(30)
const t = ((key: string) => key) as Translator

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_DRIVE_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('DrivePicker folder browsing', () => {
  it('lists only the current level and turns a known entry into a ready pick without fetching again', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url)
      if (target.includes('/drive/v3/files?')) {
        return new Response(JSON.stringify({ files: [
          { id: VIDEO, name: 'movie.mkv', mimeType: 'video/x-matroska', size: '1000' },
          { id: SUBTITLE, name: 'movie.srt', mimeType: 'text/plain', size: '50' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: FOLDER,
        name: 'My folder',
        mimeType: 'application/vnd.google-apps.folder',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<DrivePicker maxFileBytes={10_000} onPicked={vi.fn()} t={t} />)
    await user.type(screen.getByLabelText('drive.link'), `https://drive.google.com/drive/folders/${FOLDER}`)
    await user.click(screen.getByRole('button', { name: 'drive.load' }))

    await screen.findByRole('heading', { name: 'My folder' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: /movie\.mkv/ }))
    const watch = await screen.findByRole('button', { name: 'drive.confirmWatch' })
    await waitFor(() => expect(watch).toBeEnabled())
    expect(watch).toHaveAttribute('aria-busy', 'false')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
