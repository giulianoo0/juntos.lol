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
    fireEvent.change(await screen.findByLabelText(/your name|seu nome/i), { target: { value: 'giuli' } })
    fireEvent.click(screen.getByRole('button', { name: /create room|criar sala/i }))
    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(screen.getByRole('heading', { name: /start a watch room|crie uma sala/i })).toBeInTheDocument()
  })

  // A room lives a few hours and its link is the whole invitation, so a list of
  // past ones is mostly dead links — and keeping it meant writing what was
  // watched, and when, to a device the room itself never needed.
  it('keeps no record of the rooms it creates', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })
    fireEvent.click(await screen.findByRole('button', { name: /create room|criar sala/i }))

    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(localStorage.getItem('ss.room-history.v1')).toBeNull()
    expect(screen.queryByRole('button', { name: /history|histórico/i })).not.toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole('button', { name: /create room|criar sala/i }))

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
    fireEvent.click(await screen.findByRole('button', { name: /create room|criar sala/i }))

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
    fireEvent.click(await screen.findByRole('button', { name: /create room|criar sala/i }))

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
    fireEvent.change(await screen.findByLabelText(/magnet link/i), { target: { value: 'magnet:?xt=urn:btih:test' } })
    fireEvent.click(screen.getByRole('button', { name: /find files|buscar arquivos/i }))

    expect(await screen.findByRole('heading', { name: /which video|qual vídeo/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /episode-01\.mkv/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /episode-02\.mkv/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /episode-02\.mkv/i }))
    await screen.findByRole('heading', { name: /what should we call|como devemos chamar/i })
    fireEvent.click(await screen.findByRole('button', { name: /create room|criar sala/i }))

    await waitFor(() => expect(createRoomAndUploadTorrent).toHaveBeenCalledOnce())
    expect(createRoomAndUploadTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ file: episodeTwo, session: expect.objectContaining({ name: 'My show' }) }),
      '',
      expect.any(Function),
    )
    expect(destroy).not.toHaveBeenCalled()
  })

  // Back out of the file list and the magnet is where you land, still holding
  // what was typed. Dropping all the way out of the torrent flow would make a
  // mistyped character cost the whole magnet.
  it('walks back from the file list to the magnet it came from', async () => {
    const destroy = vi.fn()
    vi.mocked(openTorrent).mockResolvedValue({
      name: 'My show',
      files: [{ name: 'ep-01.mkv', path: 'show/ep-01.mkv', size: 2_000, type: 'video/x-matroska', progress: 0, downloaded: 0, read: vi.fn() }],
      subtitleFiles: [],
      stats: () => ({ peers: 2, downloadSpeed: 100, downloaded: 0, progress: 0 }),
      select: vi.fn().mockResolvedValue(undefined),
      destroy,
    })
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))
    fireEvent.change(await screen.findByLabelText(/magnet link/i), { target: { value: 'magnet:?xt=urn:btih:test' } })
    fireEvent.click(screen.getByRole('button', { name: /find files|buscar arquivos/i }))
    await screen.findByRole('button', { name: /ep-01\.mkv/i })

    fireEvent.click(screen.getByRole('button', { name: /back|voltar/i }))

    const magnet = await screen.findByLabelText(/magnet link/i)
    expect(magnet).toHaveValue('magnet:?xt=urn:btih:test')
    expect(screen.queryByRole('button', { name: /ep-01\.mkv/i })).not.toBeInTheDocument()
    // The swarm connection it was holding goes with the list.
    expect(destroy).toHaveBeenCalled()

    // And from the magnet, back again leaves the torrent flow entirely.
    fireEvent.click(screen.getByRole('button', { name: /back|voltar/i }))
    expect(await screen.findByRole('button', { name: /choose video|escolher vídeo/i })).toBeInTheDocument()
  })

  // A season pack is dozens of files, and the panel it is listed in is one
  // pill wide. Scrolling for the episode is the wrong answer when the name is
  // already known.
  it('filters the file list down to what is searched for', async () => {
    const files = ['ep-01.mkv', 'ep-02.mkv', 'extras-ncop.mkv'].map((name, index) => ({
      name, path: `show/${name}`, size: 2_000 - index, type: 'video/x-matroska', progress: 0, downloaded: 0, read: vi.fn(),
    }))
    vi.mocked(openTorrent).mockResolvedValue({
      name: 'My show',
      files,
      subtitleFiles: [],
      stats: () => ({ peers: 2, downloadSpeed: 100, downloaded: 0, progress: 0 }),
      select: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    })
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))
    fireEvent.change(await screen.findByLabelText(/magnet link/i), { target: { value: 'magnet:?xt=urn:btih:test' } })
    fireEvent.click(screen.getByRole('button', { name: /find files|buscar arquivos/i }))
    await screen.findByRole('button', { name: /extras-ncop\.mkv/i })

    fireEvent.change(screen.getByLabelText(/search files|buscar arquivo/i), { target: { value: 'ep-0' } })

    expect(screen.getByRole('button', { name: /ep-01\.mkv/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /extras-ncop\.mkv/i })).not.toBeInTheDocument()

    // A search that matches nothing says so rather than showing an empty panel.
    fireEvent.change(screen.getByLabelText(/search files|buscar arquivo/i), { target: { value: 'zzz' } })
    expect(screen.queryByRole('button', { name: /ep-01\.mkv/i })).not.toBeInTheDocument()
    expect(screen.getByText(/no file matches|nenhum arquivo/i)).toBeInTheDocument()
  })
})

describe('Home flow stays in one block', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(createRoomAndUpload).mockResolvedValue({ roomID: 'room1234', nickname: 'giuli' })
  })

  it('spells the invitation correctly', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)

    expect(screen.getByText('Solte um vídeo e assista na hora com os amigos :D')).toBeInTheDocument()
  })

  // The magnet step replaces the drop step in place. A dialog would stack a
  // second surface over the one the user is already looking at, and the whole
  // point is that picking a source never leaves the block it started in.
  it('morphs the middle block into the magnet step instead of opening a dialog', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))

    expect(await screen.findByLabelText(/magnet link/i)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose video|escolher vídeo/i })).not.toBeInTheDocument()
  })

  it('walks back out of the magnet step to the drop step', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))
    await screen.findByLabelText(/magnet link/i)

    fireEvent.click(screen.getByRole('button', { name: /back|voltar/i }))

    expect(await screen.findByRole('button', { name: /choose video|escolher vídeo/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/magnet link/i)).not.toBeInTheDocument()
  })

  // The wait belongs to the control that started it. A separate spinner row
  // makes the button look idle while it is anything but, and leaves the magnet
  // field editable when editing it can no longer change what is being fetched.
  it('turns the find button itself into the loading state', async () => {
    vi.mocked(openTorrent).mockImplementation(() => new Promise(() => undefined))
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /open torrent|abrir torrent/i }))
    fireEvent.change(await screen.findByLabelText(/magnet link/i), { target: { value: 'magnet:?xt=urn:btih:test' } })

    fireEvent.click(screen.getByRole('button', { name: /find files|buscar arquivos/i }))

    const loading = await screen.findByRole('button', { name: /fetching metadata|consultando metadata/i })
    expect(loading).toBeDisabled()
    expect(screen.getByLabelText(/magnet link/i)).toBeDisabled()
  })

  it('asks for the name in the same block a file was chosen in', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })

    expect(await screen.findByLabelText(/your name|seu nome/i)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose video|escolher vídeo/i })).not.toBeInTheDocument()
  })
})

describe('build info', () => {
  it('links the running build back to its source and its commit', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)

    const repo = screen.getByRole('link', { name: /source on github|código no github/i })
    expect(repo).toHaveAttribute('href', 'https://github.com/giulianoo0/ss')
    // A local dev build has no upstream commit to point at, so it shows the
    // repository alone rather than a link that would 404.
    expect(screen.queryByRole('link', { name: /^[0-9a-f]{7}$/ })).not.toBeInTheDocument()
  })
})
