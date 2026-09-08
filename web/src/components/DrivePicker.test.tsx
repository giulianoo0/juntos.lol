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
  it('lists only the current level and picks a video straight from the list', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url)
      if (target.includes('alt=media')) {
        return new Response(new Uint8Array([0]), { status: 206 })
      }
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

    const onPicked = vi.fn()
    render(<DrivePicker maxFileBytes={10_000} onPicked={onPicked} t={t} />)
    await user.type(screen.getByLabelText('drive.link'), `https://drive.google.com/drive/folders/${FOLDER}`)
    await user.click(screen.getByRole('button', { name: 'drive.load' }))

    await screen.findByRole('heading', { name: 'My folder' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // One click on the row is the whole pick: the only extra request is the
    // one-byte probe that turns a refused download into a named error.
    await user.click(screen.getByRole('button', { name: /movie\.mkv/ }))
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1))
    expect(onPicked.mock.calls[0][0]).toMatchObject({ name: 'movie.mkv' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
