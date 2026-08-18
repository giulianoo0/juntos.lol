import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Home, MAX_UPLOAD_BYTES } from './Home'
import { createRoomAndUpload } from '../upload'

vi.mock('../upload', () => ({ createRoomAndUpload: vi.fn() }))

describe('Home', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(createRoomAndUpload).mockResolvedValue({ roomID: 'room1234', nickname: 'giuli' })
  })

  it('renders the headline and starts upload after file selection', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText(/your name|seu nome/i), { target: { value: 'giuli' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'movie.mkv', { type: 'video/x-matroska' })] } })
    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(screen.getByText(/watch together|assista junto/i)).toBeInTheDocument()
  })

  it('rejects a file over the limit without network work', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText(/your name|seu nome/i), { target: { value: 'giuli' } })
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

    await waitFor(() => expect(createRoomAndUpload).toHaveBeenCalledOnce())
    expect(createRoomAndUpload).toHaveBeenCalledWith(expect.any(File), '', expect.any(Function))
    expect(screen.getByLabelText(/your name|seu nome/i)).toHaveValue('Guest-abc123')
  })
})
