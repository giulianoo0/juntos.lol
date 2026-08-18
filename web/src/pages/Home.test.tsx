import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Home, MAX_UPLOAD_BYTES } from './Home'
import { createRoomAndUpload, createRoomAndUploadTorrent } from '../upload'
import { openTorrent } from '../torrent'

vi.mock('../upload', () => ({ createRoomAndUpload: vi.fn(), createRoomAndUploadTorrent: vi.fn() }))
vi.mock('../torrent', () => ({ openTorrent: vi.fn() }))

describe('Home', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(createRoomAndUpload).mockResolvedValue({ roomID: 'room1234', nickname: 'giuli' })
    vi.mocked(createRoomAndUploadTorrent).mockResolvedValue({ roomID: 'torrent-room', nickname: 'giuli' })
  })

  it('renders the headline and starts upload after file selection', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })
    fireEvent.change(screen.getByLabelText(/your name|seu nome/i), { target: { value: 'giuli' } })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))
    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(screen.getByRole('heading', { name: /start a watch room|crie uma sala/i })).toBeInTheDocument()
    const history = JSON.parse(localStorage.getItem('ss.room-history.v1') ?? '[]') as Array<Record<string, unknown>>
    expect(history[0]).toMatchObject({ fileName: 'movie.mkv', id: 'room1234' })
    expect(history[0]).not.toHaveProperty('nickname')
  })

  it('rejects a file over the limit without network work', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    const file = new File(['x'], 'huge.mkv')
    Object.defineProperty(file, 'size', { value: MAX_UPLOAD_BYTES + 1 })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(createRoomAndUpload).not.toHaveBeenCalled()
  })

  it('uses the server-generated name when the name is blank', async () => {
    vi.mocked(createRoomAndUpload).mockResolvedValue({ roomID: 'room1234', nickname: 'Guest-abc123' })
    render(<MemoryRouter><Home /></MemoryRouter>)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))

    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(createRoomAndUpload).toHaveBeenCalledWith(expect.any(File), '', expect.any(Function))
    expect(localStorage.getItem('ss.nickname')).toBe('Guest-abc123')
  })

  it('shows a preparing state while an mp4 is being converted', async () => {
    vi.mocked(createRoomAndUpload).mockImplementation(async (_file, _nick, onProgress) => {
      onProgress?.({ phase: 'converting', pct: 42 })
      return new Promise(() => undefined) // conversion still running
    })
    render(<MemoryRouter><Home /></MemoryRouter>)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))

    expect(await screen.findByText(/preparing video|preparando o vídeo/i)).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()

    // A second drop while converting is ignored.
    fireEvent.change(input, { target: { files: [new File(['video'], 'other.mp4', { type: 'video/mp4' })] } })
    expect(createRoomAndUpload).toHaveBeenCalledOnce()
  })

  it('navigates to the room as soon as the upload starts in the background', async () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:id" element={<div>room page</div>} />
        </Routes>
      </MemoryRouter>,
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))

    // createRoomAndUpload resolves once the room exists, long before the
    // upload completes, so navigation must not wait for completion either.
    expect(await screen.findByText('room page')).toBeInTheDocument()
  })

  it('opens a magnet and lets the user choose one of multiple video files', async () => {
    const destroy = vi.fn()
    const episodeOne = { name: 'episode-01.mkv', path: 'show/episode-01.mkv', size: 2_000, type: 'video/x-matroska', progress: 0, downloaded: 0, read: vi.fn() }
    const episodeTwo = { name: 'episode-02.mkv', path: 'show/episode-02.mkv', size: 1_900, type: 'video/x-matroska', progress: 0, downloaded: 0, read: vi.fn() }
    vi.mocked(openTorrent).mockResolvedValue({
      name: 'My show',
      files: [episodeOne, episodeTwo],
      subtitleFiles: [],
      stats: () => ({ peers: 2, downloadSpeed: 100, downloaded: 0, progress: 0 }),
      select: vi.fn().mockResolvedValue(undefined),
      destroy,
    })

    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))
    fireEvent.change(screen.getByLabelText(/magnet link/i), { target: { value: 'magnet:?xt=urn:btih:test' } })
    fireEvent.click(screen.getByRole('button', { name: /find files|buscar arquivos/i }))

    expect(await screen.findByRole('heading', { name: /which video|qual vídeo/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /episode-01\.mkv/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /episode-02\.mkv/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /episode-02\.mkv/i }))
    await screen.findByRole('heading', { name: /what should we call|como devemos chamar/i })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))

    await waitFor(() => expect(createRoomAndUploadTorrent).toHaveBeenCalledOnce())
    expect(createRoomAndUploadTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ file: episodeTwo, session: expect.objectContaining({ name: 'My show' }) }),
      '',
      expect.any(Function),
    )
    expect(destroy).not.toHaveBeenCalled()
  })
})
